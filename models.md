# ほかの音声モデルを使う

TRPG Voice Bridge Miniには、音声モデル「Irodori-TTS-v4.1-Small」のQ4_Kの量子化モデルが入っており、このモデルを利用するように固定化されています。あなたの環境に応じて、このほかに、次のモデルも利用できます。

| モデル                 | どんなモデルか                                                                                                                       | ファイルの大きさ | ライセンス                                              | 用意のしかた                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Irodori-TTS-v4.1-Small | Miniに入っているモデル                                                                                                               | 0.86GB           | MIT                                                     | 用意は要りません                                              |
| Irodori-TTS-v4.1-Anime | Smallを、アニメ調の話し方の音声で追加学習したモデル                                                                                  | 0.86GB（Q4_K）   | MIT                                                     | スクリプトで作ります（[1](#1-anime版を作る)）                 |
| Irodori-TTS-v4-Large   | Smallの約4倍の大きさのモデル。声の説明や元の音声によく従います。そのかわり、漢字の読みは少し不正確で、音声を作るのに2〜4倍かかります | 2.62GB（Q4_K）～ | [Gemma Terms of Use](https://ai.google.dev/gemma/terms) | Miniでダウンロードします（[2](#2-large版をダウンロードする)） |

用意したモデルは、起動するときに指定します（[3](#3-モデルを指定して起動する)）。指定しなければ、いつもどおりSmallで起動します。

## 1. Anime版を作る

Anime版は、Miniで使える形式（GGUF）では公開されていません。そこで、公開されているモデルのファイルを、スクリプトでGGUFに変換します。

### 必要なもの

- Miniを展開したフォルダ（ソースから起動している場合は、そのフォルダ）
- 空き容量：9GB以上。空きが足りないときは、始める前に止まります。できあがるファイルは0.86GBで、作業用のファイルは終わると消えます
- インターネット接続：約3.1GBをダウンロードします

### スクリプトを用意する

次の2つのファイルを、Miniのフォルダ（`trpg-voice-bridge-mini` と同じ場所）に保存します。

| パソコン | 保存するファイル                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | [make_anime_model.py](https://github.com/okamichi/trpg-voice-bridge-mini/blob/main/make_anime_model.py) と [make-anime-model.sh](https://github.com/okamichi/trpg-voice-bridge-mini/blob/main/make-anime-model.sh)   |
| Windows  | [make_anime_model.py](https://github.com/okamichi/trpg-voice-bridge-mini/blob/main/make_anime_model.py) と [make-anime-model.bat](https://github.com/okamichi/trpg-voice-bridge-mini/blob/main/make-anime-model.bat) |

リンク先のページの右上にある、ダウンロードのボタン（「Download raw file」）を押すと保存できます。ソースから起動している場合は、最初からフォルダに入っているので、この手順は要りません。

### 作る

**macOS**

1. ターミナルを開きます。
2. `cd` と空白を1つ入力してから、Miniのフォルダをターミナルの画面にドラッグ＆ドロップし、Enterを押します。
3. `sh make-anime-model.sh` と入力して、Enterを押します。
4. 「開発元を確認できない」という警告が出たら、READMEの「[起動時の警告](README.md#起動時の警告)」のとおりに許可して、もう一度実行します。

**Windows**

1. Miniのフォルダの `make-anime-model.bat` をダブルクリックします。
2. 警告が出たら、「詳細情報」を押してから「実行」を押します。

「1/4」から「4/4」まで順に進み、「できました」と表示されたら完成です。Miniのフォルダに `Irodori-TTS-859M-Anime-v4.1-Q4_K.gguf` ができています。Windowsでは、何かキーを押すと画面が閉じます。

- 時間の大半はダウンロードです。
- 途中で止まったときは、もう一度同じように実行します。済んだところから続けます。
- 作業用のファイルは、Miniのフォルダの中の `work` フォルダにまとめて置き、できあがったら `work` ごと消します。パソコンのほかの場所には何も入れません。
- 作業の中身は次のとおりです。
  1. 変換に使うPythonと、そのパッケージ（numpy、safetensors、gguf、pyyaml）を `work` に入れます。
  2. モデルのファイル（[phasefield-audio/Irodori-TTS-v4.1-Anime](https://huggingface.co/phasefield-audio/Irodori-TTS-v4.1-Anime)）をダウンロードします。
  3. GGUF（F32）に変換します。Smallと共通の部分（音声コーデックなど）は、Miniに入っているSmallのファイルから取ります。
  4. Miniに入っている音声生成のプログラムで、Q4_Kに量子化します。

### Q4_K以外の種類を作る

`--type` で種類を選べます。量子化の種類は `q4_k`（指定しないとき）、`q5_k`、`q6_k`、`q8_0`、`f16` で、サイズが大きくなり、GPUのメモリもより多く消費しますが、精度は上がります。

- macOS：`sh make-anime-model.sh --type q8_0`
- Windows：Miniのフォルダでコマンドプロンプトを開き、`make-anime-model.bat --type q8_0`

Windowsでコマンドプロンプトを開くには、エクスプローラーでMiniのフォルダを開き、上のアドレス欄に `cmd` と入力してEnterを押します。そのフォルダで開いた状態になります。

できるファイルの名前は、`Irodori-TTS-859M-Anime-v4.1-Q8_0.gguf` のように種類の名前が入ります。

## 2. Large版をダウンロードする

Large版のライセンスは、Small・Animeと違い、[Gemma Terms of Use](https://ai.google.dev/gemma/terms) です。使う前に読んでください。

Miniのフォルダで、次のように入力します。

**macOS**（ターミナルで、[Anime版](#作る)と同じように `cd` してから）

```bash
SPEECH_MODEL_DIR="$PWD/models" ./runtime/speech/speech pull irodori-tts-large:q4_k
```

**Windows**（Miniのフォルダでコマンドプロンプトを開いて）

```bat
set SPEECH_MODEL_DIR=%CD%\models
runtime\speech\speech.exe pull irodori-tts-large:q4_k
```

リリース版のZIPパッケージではなくて、ソースコードからビルドして起動している場合は、`./runtime/speech/speech` を `.packaging/speech-runtime/speech` に置き換えて実行してください。

- `SPEECH_MODEL_DIR` は保存先です。フォルダの場所を最初から（`/` やドライブ名から）書く必要があるので、`"$PWD/models"`（Windowsでは `%CD%\models`）と書いて、今いるフォルダの中の `models` を指定しています。
- 最後に、保存した場所が表示されます。保存先は種類ごとに違い、`q4_k` なら `models/sakasegawa--Irodori-TTS-v4-Large-GGUF/ac3e473f…/Irodori-TTS-3.4B-v4-Q4_K.gguf` です。
- 大きさとSHA-256を確かめてから保存します。途中で止まったときは、もう一度同じように入力すると、続きからダウンロードします。

Large版は、音声を作るときのメモリも多く使います。同じセリフを作ったとき、Smallの約1.1GBに対して、Large版（Q4_K）は約2.9GBでした（Apple M4 MaxのMacで測った値）。

選べる種類は次のとおりです。`irodori-tts-large:q4_k` の `q4_k` の部分を入れ替えます。

| 指定                     | 大きさ         |
| ------------------------ | -------------- |
| `irodori-tts-large:q4_k` | 2.62GB         |
| `irodori-tts-large:q5_k` | 2.93GB         |
| `irodori-tts-large:q6_k` | 3.27GB         |
| `irodori-tts-large`      | 3.88GB（Q8_0） |
| `irodori-tts-large:f16`  | 6.96GB         |

量子化の種類は `q4_k`、`q5_k`、`q6_k`、`q8_0`、`f16` で、サイズが大きくなり、GPUのメモリもより多く消費しますが、精度は上がります。

## 3. モデルを指定して起動する

起動するときに、環境変数 `TRPG_VOICE_BRIDGE_MINI_MODEL` に、使うモデルのファイルの場所を入れます。

**macOS**（ターミナルで、Miniのフォルダに `cd` してから）

```bash
# Anime版
TRPG_VOICE_BRIDGE_MINI_MODEL=./Irodori-TTS-859M-Anime-v4.1-Q4_K.gguf ./trpg-voice-bridge-mini

# Large版
TRPG_VOICE_BRIDGE_MINI_MODEL=./models/sakasegawa--Irodori-TTS-v4-Large-GGUF/ac3e473f393b620c108c18ba848c337abb6d2348844da90c8b291812dd96bd6e/Irodori-TTS-3.4B-v4-Q4_K.gguf ./trpg-voice-bridge-mini
```

**Windows**（Miniのフォルダでコマンドプロンプトを開いて）

```bat
rem Anime版
set TRPG_VOICE_BRIDGE_MINI_MODEL=.\Irodori-TTS-859M-Anime-v4.1-Q4_K.gguf
trpg-voice-bridge-mini.exe
```

```bat
rem Large版
set TRPG_VOICE_BRIDGE_MINI_MODEL=.\models\sakasegawa--Irodori-TTS-v4-Large-GGUF\ac3e473f393b620c108c18ba848c337abb6d2348844da90c8b291812dd96bd6e\Irodori-TTS-3.4B-v4-Q4_K.gguf
trpg-voice-bridge-mini.exe
```

ソースから起動している場合は、`./trpg-voice-bridge-mini` を `npm start` に置き換えます。

- 指定が効くのは、その起動のときだけです。次にふつうに起動すると、Smallに戻ります。Windowsの `set` は、そのコマンドプロンプトの画面を閉じるまで効きます。
- ファイルが見つからないときは、「音声モデルが見つかりません」と表示して起動しません。
- 起動オプション（`--steps` など）も、いつもどおり付けられます。
- キャラと声の登録（`data` フォルダ）は、モデルを替えてもそのまま使えます。登録した声の元になる音声は、Anime版でもLarge版でも読み上げに使えます。

## 注意

- モデルのライセンスと利用上の制限（モデルカードの記載）に従ってください。
  - Anime版：MITライセンスで、Smallと同じ利用上の制限があります（[モデルカード](https://huggingface.co/phasefield-audio/Irodori-TTS-v4.1-Anime)）。
  - Large版：[Gemma Terms of Use](https://ai.google.dev/gemma/terms) です（[モデルカード](https://huggingface.co/Aratako/Irodori-TTS-v4-Large)）。
- Anime版のモデルカードには、声の説明と絵文字の効き方がSmallと違う場合がある、と書かれています。Miniの声の説明や、（怒り）などの演技の指示の効き方が変わることがあります。
- 音声を作るときのステップ数（最初は12）は、Smallで聴き比べて決めた値です。ほかのモデルで聞こえ方が気になるときは、`--steps` で変えてみてください。
- [README](README.md#利用上の注意)の「利用上の注意」も守ってください。
