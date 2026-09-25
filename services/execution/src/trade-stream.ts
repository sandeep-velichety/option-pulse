import type { streaming } from '@alpacahq/alpaca-trade-api';
type TradingStream = streaming.TradingStream;
import { alpaca } from './alpaca.js';
import { handleFill } from './fill-writer.js';

let _stream: TradingStream | null = null;

export function startTradeStream(): void {
  const stream = alpaca.trading.stream();
  _stream = stream;

  stream.subscribeTradeUpdates();

  stream.onTradeUpdate((update) => {
    handleFill(update).catch((err) => {
      console.error('[execution] trade-stream: handleFill error', err);
    });
  });

  stream.onConnect(() => {
    console.log('[execution] trade-stream: connected and authenticated');
  });

  stream.onReconnected(() => {
    console.log('[execution] trade-stream: reconnected');
  });

  stream.onError((err) => {
    console.error('[execution] trade-stream: error', err);
  });

  stream.connect();
}

export function stopStream(): void {
  if (_stream) {
    _stream.disconnect();
    _stream = null;
    console.log('[execution] trade-stream: disconnected');
  }
}
