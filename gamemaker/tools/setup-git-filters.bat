@echo off
cd /d "%~dp0\.."
git config filter.stripextdate.clean "perl tools/strip-ext-date.pl"
git config filter.stripyyporder.clean "perl tools/strip-yyp-order.pl"
git add --renormalize extensions
git add --renormalize PizzaTower_GM2.yyp
echo stripextdate + stripyyporder filters configured.
