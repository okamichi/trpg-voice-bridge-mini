#!/bin/sh
# 
# 「Irodori-TTS-v4.1-Anime」か「Irodori-TTS-v4.1-Small-Yomi」のGGUFファイルを取得・変換するスクリプト。
# 実行すると、どちらを作るかを番号で選ぶ。最初から指定する場合は：
# ./make-model.sh --model yomi
# 量子化 Q4_K以外のタイプの場合は：
# ./make-model.sh --type q8_0
#
# 生成したGGUFモデルの指定方法は次のように環境変数で設定する
# TRPG_VOICE_BRIDGE_MINI_MODEL=./Irodori-TTS-859M-Anime-v4.1-Q4_K.gguf npm start
# 
cd "$(dirname "$0")" || exit 1
root=$(pwd)
work="$root/work"
uv_version=0.13.6
uv_file=uv-aarch64-apple-darwin.tar.gz
uv_sha256=60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472
export UV_CACHE_DIR="$work/uv-cache" UV_PYTHON_INSTALL_DIR="$work/python" \
  UV_PYTHON_BIN_DIR="$work/python/bin" UV_PYTHON_PREFERENCE=only-managed \
  UV_NO_CONFIG=1

if [ "$(uname -m)" != arm64 ]; then
  echo "このスクリプトは、Apple SiliconのMacで使えます。"
  exit 1
fi
if [ ! -x "$work/uv/uv" ]; then
  mkdir -p "$work/downloads" "$work/uv" || exit 1
  archive="$work/downloads/$uv_file"
  if ! /usr/bin/curl --fail --location --retry 5 --silent --show-error \
    --output "$archive" \
    "https://github.com/astral-sh/uv/releases/download/$uv_version/$uv_file"; then
    echo "uvをダウンロードできませんでした。ネットワークを確認して、もう一度実行してください。"
    exit 1
  fi
  if [ "$(/usr/bin/shasum -a 256 "$archive" | cut -d ' ' -f 1)" != "$uv_sha256" ]; then
    rm -f "$archive"
    echo "ダウンロードしたuvの中身が想定と違いました。もう一度実行してください。"
    exit 1
  fi
  /usr/bin/tar -xzf "$archive" -C "$work/uv" --strip-components=1 || exit 1
fi

"$work/uv/uv" run --quiet --no-project --python 3.10 "$root/make_model.py" "$@"
status=$?
if [ "$status" -eq 0 ] && [ -f "$work/.done" ]; then
  rm -rf "$work"
fi
exit "$status"
