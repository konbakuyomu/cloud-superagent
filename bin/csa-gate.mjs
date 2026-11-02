#!/usr/bin/env node
// csa-gate …：等于 csa gate …，单独装成一个命令。
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main('gate', process.argv.slice(2));
