// Saves an API key without the web page: node set-key.mjs deepseek   (or: claude)
import readline from 'node:readline';
import { saveSettings } from './ai.mjs';

const provider = (process.argv[2] || 'deepseek').toLowerCase();
if (!['deepseek', 'claude'].includes(provider)) {
  console.error('Usage: node set-key.mjs deepseek|claude');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Paste your ${provider === 'deepseek' ? 'DeepSeek' : 'Claude'} API key and press Enter: `, async key => {
  rl.close();
  key = key.trim();
  if (!key) { console.error('No key entered. Nothing saved.'); process.exit(1); }
  const s = await saveSettings(provider === 'deepseek' ? { deepseekKey: key, provider } : { apiKey: key, provider });
  const k = s[provider];
  console.log(k.hasKey ? `Saved. Key ending ${k.keyHint}. ${provider === 'deepseek' ? 'DeepSeek' : 'Claude'} is now the AI provider.` : 'Not saved.');
});
