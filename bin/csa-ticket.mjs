#!/usr/bin/env node
// csa-ticket …：等于 csa ticket …，单独装成一个命令。
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main('ticket', process.argv.slice(2));
