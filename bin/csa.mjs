#!/usr/bin/env node
// csa <queue|ticket|gate|patrol> …：用 tsx 直接跑 src/ 里的 TypeScript，不用先编译。
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
const [command, ...argv] = process.argv.slice(2);
process.exitCode = await main(command, argv);
