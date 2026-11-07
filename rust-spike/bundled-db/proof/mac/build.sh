#!/bin/bash
# Runs ON THE MAC. Builds Postgres 17.11 + pgvector 0.8.7 into ~/moss-js37/pg with Xcode clang.
# Uses the Mac's existing Homebrew ICU and zstd for the test build; installs nothing.
set -euo pipefail
S=~/moss-js37
cd $S/build
rm -rf postgresql-17.11 pgvector-0.8.7
tar xjf $S/downloads/postgresql-17.11.tar.bz2
tar xzf $S/downloads/pgvector-0.8.7.tar.gz
ICU=/opt/homebrew/opt/icu4c ZSTD=/opt/homebrew/opt/zstd
cd postgresql-17.11
./configure --prefix=$S/pg --without-readline --with-icu --with-zstd --without-openssl \
  ICU_CFLAGS="-I$ICU/include" ICU_LIBS="-L$ICU/lib -licui18n -licuuc -licudata" \
  ZSTD_CFLAGS="-I$ZSTD/include" ZSTD_LIBS="-L$ZSTD/lib -lzstd" > $S/build/configure.log 2>&1
make -j8 > $S/build/make.log 2>&1
make install > $S/build/install.log 2>&1
cd $S/build/pgvector-0.8.7
make PG_CONFIG=$S/pg/bin/pg_config OPTFLAGS="" > $S/build/pgvector.log 2>&1
make PG_CONFIG=$S/pg/bin/pg_config install >> $S/build/pgvector.log 2>&1
echo BUILD-OK > $S/build/done
