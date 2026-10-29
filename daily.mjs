// Entry point for the scheduled task: node daily.mjs
import { runDaily } from './collector.mjs';

await runDaily();
