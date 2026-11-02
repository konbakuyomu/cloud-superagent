#!/usr/bin/env node
// csa-queue …：等于 csa queue …，单独装成一个命令。
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main('queue', process.argv.slice(2));
