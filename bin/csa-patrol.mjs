#!/usr/bin/env node
// csa-patrol …：等于 csa patrol …，单独装成一个命令。
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main('patrol', process.argv.slice(2));
