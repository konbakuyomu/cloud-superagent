#!/usr/bin/env bash
# 提交前查私人信息。没有匹配就打印「干净」、退出码 0；有匹配就列出来、退出码 1。
# 通用的模式写在这里；只有你自己知道的词（用户名、私人域名、项目代号）一行一个写进仓库以外的文件，
# 用 CSA_PRIVATE_TERMS=<文件> 传进来，按字面、不分大小写查。那个文件不要提交。
set -u
cd "$(git rev-parse --show-toplevel)"
found=0
scan() {
  local name=$1; shift
  local out
  out=$(git grep -nIE "$@" -- . ':!package-lock.json' 2>/dev/null)
  if [ -n "$out" ]; then echo "== $name"; echo "$out"; found=1; fi
}
scan '个人路径'  '\b[A-Za-z]:[\\/][^\\/[:space:]]+[\\/]|[\\]Users[\\]|/Users/[A-Za-z]|/home/[A-Za-z]'
scan '会话、定时任务、环境 id' 'session_[0-9A-Za-z]{8}|trig_[0-9A-Za-z]{6}|env_[0-9A-Za-z]{8}'
scan '邮箱' '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+[.][A-Za-z]{2,}'
scan '令牌' 'gh[pousr]_[0-9A-Za-z]{20}|github_pat_[0-9A-Za-z]{20}|sk-[0-9A-Za-z]{20}|xox[bpas]-[0-9A-Za-z]|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY'
if [ -n "${CSA_PRIVATE_TERMS:-}" ]; then
  out=$(git grep -nIiF -f "$CSA_PRIVATE_TERMS" -- . 2>/dev/null)
  if [ -n "$out" ]; then echo "== 私人词表"; echo "$out"; found=1; fi
fi
[ $found = 0 ] && echo '干净'
exit $found
