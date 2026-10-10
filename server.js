// Start the server: node server.js   (Render, Railway, a VM, Docker, or your laptop)
import { createServer } from 'node:http';
import { handle, ready } from './src/app.js';
import { config, VERSION } from './src/config.js';

await ready();
createServer(handle).listen(config.port, () => {
  console.log(`${config.appName} ${VERSION} running on http://localhost:${config.port}`);
  console.log(`  Field app: /        Admin console: /console`);
  if (config.aiMock) console.log('  DEMO AI is ON (AI_MOCK=1): answers are fake. Turn it off for real customers.');
});
