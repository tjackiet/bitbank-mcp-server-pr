#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BigNumber } from 'bignumber.js';
import dayjs from 'dayjs';
import { z } from 'zod';
import { BITBANK_API_BASE, fetchJson } from './client.js';
import { ALLOWED_PAIRS, ensurePair, pairRegex } from './config/pair.js';
import {
  CandlestickResponse,
  DepthResponse,
  NormalizedCandle,
  NormalizedDepthEntry,
  NormalizedTicker,
  NormalizedTransaction,
  TickerResponse,
  TickersJpyResponse,
  TickersResponse,
  TransactionsResponse,
} from './types.js';
import { toIsoTime } from './utils/datetime.js';
import { formatChange, formatPair, formatPrice, formatVolume } from './utils/format.js';

// Create server instance
const server = new McpServer({
  name: 'bitbank',
  version: '0.2.0',
});

// ============================================================
// get_ticker - 単一ペアのティッカー情報を取得
// ============================================================
function registerGetTicker(server: McpServer) {
  server.tool(
    'get_ticker',
    'Get ticker data for a trading pair',
    {
      pair: z.string().regex(pairRegex).describe('Trading pair (e.g., btc_jpy, eth_jpy)'),
    },
    async ({ pair }) => {
      const chk = ensurePair(pair);
      if (!chk.ok) {
        return { content: [{ type: 'text', text: chk.error.message }] };
      }

      try {
        const json = await fetchJson<TickerResponse>(`${BITBANK_API_BASE}/${chk.pair}/ticker`, { timeoutMs: 5000 });

        if (!json || json.success !== 1) {
          return { content: [{ type: 'text', text: 'Failed to retrieve ticker data' }] };
        }

        const d = json.data;
        const isJpy = chk.pair.includes('jpy');
        const baseCurrency = chk.pair.split('_')[0]?.toUpperCase() ?? '';

        const last = Number(d.last);
        const open = Number(d.open);
        const high = Number(d.high);
        const low = Number(d.low);
        const buy = Number(d.buy);
        const sell = Number(d.sell);
        const vol = Number(d.vol);

        // 変動率計算
        const changePct = open > 0 ? ((last - open) / open) * 100 : null;
        // スプレッド計算
        const spread = sell - buy;
        // JPY出来高
        const jpyVol = BigNumber(d.vol).multipliedBy(BigNumber(d.last)).toFixed(0);

        // 出力フォーマット
        const lines: string[] = [];
        lines.push(`${formatPair(chk.pair)} 現在値: ${formatPrice(last, isJpy)}`);
        lines.push(`24h: 始値 ${formatPrice(open, isJpy)} / 高値 ${formatPrice(high, isJpy)} / 安値 ${formatPrice(low, isJpy)}`);
        if (changePct !== null) {
          lines.push(`24h変動: ${formatChange(changePct)}`);
        }
        lines.push(`出来高: ${formatVolume(vol, baseCurrency)}`);
        if (isJpy) {
          lines.push(`出来高(税): ¥${Number(jpyVol).toLocaleString('ja-JP')}`);
        }
        lines.push(`Bid: ${formatPrice(buy, isJpy)} / Ask: ${formatPrice(sell, isJpy)}（スプレッド: ${formatPrice(spread, isJpy)}）`);
        lines.push(`時刻: ${dayjs.unix(d.timestamp / 1000).format('YYYY-MM-DD HH:mm:ss')}`);
        lines.push('---');
        lines.push(`チャート・取引: https://app.bitbank.cc/trade/${chk.pair}`);

        const normalized: NormalizedTicker = {
          pair: chk.pair,
          last,
          buy,
          sell,
          open,
          high,
          low,
          volume: vol,
          timestamp: d.timestamp,
          isoTime: toIsoTime(d.timestamp),
          change24hPct: changePct ? Number(changePct.toFixed(2)) : null,
          vol24hJpy: isJpy ? Number(jpyVol) : null,
        };

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { raw: json, normalized },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'ネットワークエラー';
        return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
      }
    },
  );
}

// ============================================================
// get_tickers - 全ペアのティッカー情報を一括取得
// ============================================================
const tickersCache: { fetchedAt: number; items: NormalizedTicker[] } | null = null;
const TICKERS_CACHE_TTL = 3000;

function registerGetTickers(server: McpServer) {
  server.tool(
    'get_tickers',
    'Get ticker data for all trading pairs',
    {
      market: z.enum(['all', 'jpy']).default('all').describe('Market filter: all or jpy'),
    },
    async ({ market }) => {
      try {
        const json = await fetchJson<TickersResponse>(`${BITBANK_API_BASE}/tickers`, { timeoutMs: 5000 });

        if (!json || json.success !== 1 || !Array.isArray(json.data)) {
          return { content: [{ type: 'text', text: 'Failed to retrieve tickers data' }] };
        }

        let items = json.data.map((d) => {
          const pair = String(d.pair);
          const last = Number(d.last);
          const open = Number(d.open);
          const volume = Number(d.vol);
          const change24hPct = open > 0 ? Number((((last - open) / open) * 100).toFixed(2)) : null;
          const vol24hJpy = pair.includes('jpy') ? Math.round(last * volume) : null;

          return {
            pair,
            last,
            buy: Number(d.buy),
            sell: Number(d.sell),
            open,
            high: Number(d.high),
            low: Number(d.low),
            volume,
            timestamp: d.timestamp,
            isoTime: toIsoTime(d.timestamp),
            change24hPct,
            vol24hJpy,
          } as NormalizedTicker;
        });

        // マーケットフィルタ
        if (market === 'jpy') {
          items = items.filter((x) => x.pair.endsWith('_jpy'));
        }

        // サマリ生成
        const lines: string[] = [];
        lines.push(`全${items.length}ペア取得`);
        lines.push('');

        // 上位5件を表示
        for (const item of items.slice(0, 5)) {
          const isJpy = item.pair.includes('jpy');
          const priceStr = formatPrice(item.last, isJpy);
          const changeStr = formatChange(item.change24hPct ?? null);
          lines.push(`${formatPair(item.pair)}: ${priceStr} (${changeStr})`);
        }

        if (items.length > 5) {
          lines.push(`... 他${items.length - 5}ペア`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { items, meta: { market, count: items.length, fetchedAt: new Date().toISOString() } },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'ネットワークエラー';
        return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
      }
    },
  );
}

// ============================================================
// get_tickers_jpy - JPYペアのみ取得（厳格フィルタ付き）
// ============================================================
let tickersJpyCache: { ts: number; data: NormalizedTicker[] } | null = null;
const TICKERS_JPY_CACHE_TTL = 10000;

function registerGetTickersJpy(server: McpServer) {
  server.tool('get_tickers_jpy', 'Get ticker data for JPY trading pairs only', {}, async () => {
    const now = Date.now();

    // キャッシュチェック
    if (tickersJpyCache && now - tickersJpyCache.ts < TICKERS_JPY_CACHE_TTL) {
      return {
        content: [{ type: 'text', text: `JPYペア ${tickersJpyCache.data.length}件 (cached)` }],
        structuredContent: { items: tickersJpyCache.data, meta: { cached: true } },
      };
    }

    try {
      const json = await fetchJson<TickersJpyResponse>(`${BITBANK_API_BASE}/tickers_jpy`, { timeoutMs: 5000 });

      if (!json || json.success !== 1 || !Array.isArray(json.data)) {
        return { content: [{ type: 'text', text: 'Failed to retrieve tickers_jpy data' }] };
      }

      // ALLOWED_PAIRSでフィルタ
      const filtered = json.data.filter((d) => ALLOWED_PAIRS.has(d.pair));

      const items: NormalizedTicker[] = filtered.map((d) => {
        const last = Number(d.last);
        const open = Number(d.open);
        const volume = Number(d.vol);
        const change24hPct = open > 0 ? Number((((last - open) / open) * 100).toFixed(2)) : null;

        return {
          pair: d.pair,
          last,
          buy: Number(d.buy),
          sell: Number(d.sell),
          open,
          high: Number(d.high),
          low: Number(d.low),
          volume,
          timestamp: d.timestamp,
          isoTime: toIsoTime(d.timestamp),
          change24hPct,
          vol24hJpy: Math.round(last * volume),
        };
      });

      tickersJpyCache = { ts: now, data: items };

      // サマリ
      const lines: string[] = [];
      lines.push(`JPYペア ${items.length}件取得`);
      for (const item of items.slice(0, 5)) {
        lines.push(`${formatPair(item.pair)}: ${formatPrice(item.last, true)} (${formatChange(item.change24hPct ?? null)})`);
      }
      if (items.length > 5) {
        lines.push(`... 他${items.length - 5}ペア`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { items, meta: { count: items.length, fetchedAt: new Date().toISOString() } },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'ネットワークエラー';
      return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
    }
  });
}

// ============================================================
// get_candles - ローソク足データを取得
// ============================================================
const CANDLE_TYPES = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day', '1week', '1month'] as const;
const YEARLY_TYPES = new Set(['4hour', '8hour', '12hour', '1day', '1week', '1month']);

function registerGetCandles(server: McpServer) {
  server.tool(
    'get_candles',
    'Get candlestick (OHLCV) data for a trading pair',
    {
      pair: z.string().regex(pairRegex).describe('Trading pair (e.g., btc_jpy)'),
      type: z.enum(CANDLE_TYPES).default('1day').describe('Candle type/timeframe'),
      date: z.string().optional().describe('Date in YYYYMMDD (for minute/hour) or YYYY (for day/week/month)'),
      limit: z.number().min(1).max(1000).default(200).describe('Number of candles to return'),
    },
    async ({ pair, type, date, limit }) => {
      const chk = ensurePair(pair);
      if (!chk.ok) {
        return { content: [{ type: 'text', text: chk.error.message }] };
      }

      // 日付の処理
      const isYearly = YEARLY_TYPES.has(type);
      let dateParam: string;

      if (date) {
        dateParam = isYearly ? date.substring(0, 4) : date;
      } else {
        const now = new Date();
        if (isYearly) {
          dateParam = String(now.getFullYear());
        } else {
          const m = String(now.getMonth() + 1).padStart(2, '0');
          const d = String(now.getDate()).padStart(2, '0');
          dateParam = `${now.getFullYear()}${m}${d}`;
        }
      }

      try {
        const url = `${BITBANK_API_BASE}/${chk.pair}/candlestick/${type}/${dateParam}`;
        const json = await fetchJson<CandlestickResponse>(url, { timeoutMs: 8000 });

        if (!json || json.success !== 1) {
          return { content: [{ type: 'text', text: 'Failed to retrieve candlestick data' }] };
        }

        const ohlcv = json.data?.candlestick?.[0]?.ohlcv ?? [];

        if (ohlcv.length === 0) {
          return { content: [{ type: 'text', text: `ローソク足データが見つかりません (${chk.pair}/${type}/${dateParam})` }] };
        }

        const rows = ohlcv.slice(-limit);
        const normalized: NormalizedCandle[] = rows.map(([o, h, l, c, v, ts]) => ({
          open: Number(o),
          high: Number(h),
          low: Number(l),
          close: Number(c),
          volume: Number(v),
          timestamp: ts,
          isoTime: toIsoTime(ts),
        }));

        const latest = normalized[normalized.length - 1];
        const oldest = normalized[0];
        const isJpy = chk.pair.includes('jpy');

        // サマリ生成
        const lines: string[] = [];
        lines.push(`${formatPair(chk.pair)} [${type}] ローソク足${normalized.length}本取得`);
        lines.push(`期間: ${oldest.isoTime?.split('T')[0] ?? 'N/A'} 〜 ${latest.isoTime?.split('T')[0] ?? 'N/A'}`);
        lines.push(`最新終値: ${formatPrice(latest.close, isJpy)}`);
        lines.push('');
        lines.push(`⚠️ 配列は古い順: data[0]=最古、data[${normalized.length - 1}]=最新`);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            normalized,
            meta: { pair: chk.pair, type, date: dateParam, count: normalized.length },
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'ネットワークエラー';
        return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
      }
    },
  );
}

// ============================================================
// get_orderbook - 板情報（上位N層）を取得
// ============================================================
function registerGetOrderbook(server: McpServer) {
  server.tool(
    'get_orderbook',
    'Get order book (bid/ask) for a trading pair',
    {
      pair: z.string().regex(pairRegex).describe('Trading pair (e.g., btc_jpy)'),
      topN: z.number().min(1).max(200).default(20).describe('Number of price levels to return'),
    },
    async ({ pair, topN }) => {
      const chk = ensurePair(pair);
      if (!chk.ok) {
        return { content: [{ type: 'text', text: chk.error.message }] };
      }

      try {
        const url = `${BITBANK_API_BASE}/${chk.pair}/depth`;
        const json = await fetchJson<DepthResponse>(url, { timeoutMs: 3000 });

        if (!json || json.success !== 1) {
          return { content: [{ type: 'text', text: 'Failed to retrieve orderbook data' }] };
        }

        const d = json.data;

        // 累積サイズを計算しながら変換
        const toLevels = (arr: Array<[string, string]>): NormalizedDepthEntry[] => {
          let cumTotal = 0;
          return arr.slice(0, topN).map(([price, amount]) => {
            const p = Number(price);
            const a = Number(amount);
            cumTotal += a;
            return { price: p, amount: a, total: Number(cumTotal.toFixed(8)) };
          });
        };

        const bids = toLevels(d.bids);
        const asks = toLevels(d.asks);

        const bestBid = bids[0]?.price ?? null;
        const bestAsk = asks[0]?.price ?? null;
        const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
        const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;

        const isJpy = chk.pair.includes('jpy');
        const baseCurrency = chk.pair.split('_')[0]?.toUpperCase() ?? '';

        // サマリ生成
        const lines: string[] = [];
        lines.push(`${formatPair(chk.pair)} 板情報 (上位${topN}層)`);
        lines.push(`中値: ${mid ? formatPrice(mid, isJpy) : 'N/A'}`);
        lines.push(`スプレッド: ${spread ? formatPrice(spread, isJpy) : 'N/A'}`);
        lines.push('');
        lines.push(`🟢 買い板 (Bids): ${bids.length}層`);
        for (const b of bids.slice(0, 5)) {
          lines.push(`  ${formatPrice(b.price, isJpy)} - ${b.amount.toFixed(4)} ${baseCurrency}`);
        }
        if (bids.length > 5) lines.push(`  ... 他${bids.length - 5}層`);
        lines.push('');
        lines.push(`🔴 売り板 (Asks): ${asks.length}層`);
        for (const a of asks.slice(0, 5)) {
          lines.push(`  ${formatPrice(a.price, isJpy)} - ${a.amount.toFixed(4)} ${baseCurrency}`);
        }
        if (asks.length > 5) lines.push(`  ... 他${asks.length - 5}層`);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            normalized: {
              pair: chk.pair,
              bestBid,
              bestAsk,
              spread,
              mid,
              bids,
              asks,
              timestamp: d.timestamp,
              isoTime: toIsoTime(d.timestamp),
            },
            meta: { pair: chk.pair, topN, count: bids.length + asks.length },
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'ネットワークエラー';
        return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
      }
    },
  );
}

// ============================================================
// get_depth - 板深度（詳細版）を取得
// ============================================================
function registerGetDepth(server: McpServer) {
  server.tool(
    'get_depth',
    'Get full order book depth for a trading pair',
    {
      pair: z.string().regex(pairRegex).describe('Trading pair (e.g., btc_jpy)'),
      maxLevels: z.number().min(1).max(500).default(200).describe('Maximum number of price levels'),
    },
    async ({ pair, maxLevels }) => {
      const chk = ensurePair(pair);
      if (!chk.ok) {
        return { content: [{ type: 'text', text: chk.error.message }] };
      }

      try {
        const url = `${BITBANK_API_BASE}/${chk.pair}/depth`;
        const json = await fetchJson<DepthResponse>(url, { timeoutMs: 3000 });

        if (!json || json.success !== 1) {
          return { content: [{ type: 'text', text: 'Failed to retrieve depth data' }] };
        }

        const d = json.data;
        const asks = d.asks.slice(0, maxLevels).map(([p, s]) => [Number(p), Number(s)]);
        const bids = d.bids.slice(0, maxLevels).map(([p, s]) => [Number(p), Number(s)]);

        const bestAsk = asks[0]?.[0] ?? null;
        const bestBid = bids[0]?.[0] ?? null;
        const mid = bestBid && bestAsk ? Number(((bestBid + bestAsk) / 2).toFixed(2)) : null;

        const isJpy = chk.pair.includes('jpy');

        // サマリ
        const lines: string[] = [];
        lines.push(`${formatPair(chk.pair)} 板深度`);
        lines.push(`中値: ${mid ? formatPrice(mid, isJpy) : 'N/A'}`);
        lines.push(`板の層数: 買い ${bids.length}層 / 売り ${asks.length}層`);
        lines.push(`時刻: ${toIsoTime(d.timestamp) ?? 'N/A'}`);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            asks,
            bids,
            timestamp: d.timestamp,
            sequenceId: d.sequenceId,
            meta: { pair: chk.pair, maxLevels, asksCount: asks.length, bidsCount: bids.length },
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'ネットワークエラー';
        return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
      }
    },
  );
}

// ============================================================
// get_transactions - 取引履歴を取得
// ============================================================
function registerGetTransactions(server: McpServer) {
  server.tool(
    'get_transactions',
    'Get recent transactions for a trading pair',
    {
      pair: z.string().regex(pairRegex).describe('Trading pair (e.g., btc_jpy)'),
      limit: z.number().min(1).max(1000).default(100).describe('Number of transactions to return'),
      date: z.string().optional().describe('Date in YYYYMMDD format (optional)'),
    },
    async ({ pair, limit, date }) => {
      const chk = ensurePair(pair);
      if (!chk.ok) {
        return { content: [{ type: 'text', text: chk.error.message }] };
      }

      try {
        const url = date ? `${BITBANK_API_BASE}/${chk.pair}/transactions/${date}` : `${BITBANK_API_BASE}/${chk.pair}/transactions`;
        const json = await fetchJson<TransactionsResponse>(url, { timeoutMs: 4000 });

        if (!json || json.success !== 1) {
          return { content: [{ type: 'text', text: 'Failed to retrieve transactions data' }] };
        }

        const txns = json.data?.transactions ?? [];

        const normalized: NormalizedTransaction[] = txns
          .map((t) => ({
            transactionId: t.transaction_id,
            side: t.side,
            price: Number(t.price),
            amount: Number(t.amount),
            executedAt: t.executed_at,
            isoTime: toIsoTime(t.executed_at),
          }))
          .sort((a, b) => a.executedAt - b.executedAt)
          .slice(-limit);

        const buys = normalized.filter((t) => t.side === 'buy').length;
        const sells = normalized.filter((t) => t.side === 'sell').length;
        const total = buys + sells;
        const buyRatio = total > 0 ? Math.round((buys / total) * 100) : 0;

        const isJpy = chk.pair.includes('jpy');
        const baseCurrency = chk.pair.split('_')[0]?.toUpperCase() ?? '';
        const totalVolume = normalized.reduce((sum, t) => sum + t.amount, 0);

        // サマリ
        const lines: string[] = [];
        lines.push(`${formatPair(chk.pair)} 直近取引 ${normalized.length}件`);
        if (normalized.length > 0) {
          const latest = normalized[normalized.length - 1];
          lines.push(`最新約定: ${formatPrice(latest.price, isJpy)}`);

          const dominant = buyRatio >= 60 ? '買い優勢' : buyRatio <= 40 ? '売り優勢' : '拮抗';
          lines.push(`買い: ${buys}件 / 売り: ${sells}件（${dominant}）`);

          const volStr = totalVolume >= 1 ? totalVolume.toFixed(4) : totalVolume.toFixed(6);
          lines.push(`出来高: ${volStr} ${baseCurrency}`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            normalized,
            meta: { pair: chk.pair, count: normalized.length, buys, sells, source: date ? 'by_date' : 'latest' },
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'ネットワークエラー';
        return { content: [{ type: 'text', text: `エラー: ${msg}` }] };
      }
    },
  );
}

// ============================================================
// ツール登録
// ============================================================
registerGetTicker(server);
registerGetTickers(server);
registerGetTickersJpy(server);
registerGetCandles(server);
registerGetOrderbook(server);
registerGetDepth(server);
registerGetTransactions(server);

// ============================================================
// サーバー起動
// ============================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Bitbank MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
