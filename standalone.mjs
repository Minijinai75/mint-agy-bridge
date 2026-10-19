// Run the bridge without SillyTavern:  node standalone.mjs
// Same endpoint (http://127.0.0.1:5499/v1 by default); handy for testing or for other OpenAI-compatible clients.
import { init, exit } from './index.mjs';

await init(null);
const stop = async () => { await exit(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
