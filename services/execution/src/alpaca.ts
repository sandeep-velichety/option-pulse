import { Alpaca } from '@alpacahq/alpaca-trade-api';

const key = process.env['ALPACA_KEY'];
const secret = process.env['ALPACA_SECRET'];

if (!key) throw new Error('[execution] ALPACA_KEY is required');
if (!secret) throw new Error('[execution] ALPACA_SECRET is required');

const paper = process.env['ALPACA_PAPER'] !== 'false';

export const alpaca = new Alpaca({ keyId: key, secret, paper });
