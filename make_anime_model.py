"""Makes Irodori-TTS-v4.1-Anime, a fine-tune of the model TRPG Voice Bridge Mini carries, into a GGUF file in Mini's
folder.

make-anime-model.sh (macOS) and make-anime-model.bat (Windows) fetch uv into work/ and run this file with a Python
that uv installs there. It installs the four Python packages the conversion needs, fetches the checkpoint, converts it
to an F32 GGUF file and quantizes that with Mini's speech. The codec and the official runtime's defaults, which the
fine-tune shares with Irodori-TTS-v4.1-Small, come from the Small model Mini carries, so neither PyTorch nor the codec's
weights are fetched. Everything but the result goes into work/. The launcher removes work/ once the file is made; after
a failure it stays, and running again resumes.

usage: make_anime_model.py [--type q4_k|q5_k|q6_k|q8_0|f16] [--keep-work]
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

WINDOWS = os.name == "nt"
EXE = ".exe" if WINDOWS else ""
ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work"
UV = WORK / "uv" / f"uv{EXE}"
CURL = Path(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe") if WINDOWS else Path("/usr/bin/curl")

# The model Mini carries (Mini's mini/model.mjs).
SMALL = {"file": "Irodori-TTS-859M-v4.1-Q4_K.gguf", "size": 859871072,
         "sha256": "a1c174f4552817e84dd6a2a020bc3d0589fd7f30d0c3db53ad04a1e69fb5dbfd"}
# The checkpoint's files the conversion reads. The repository also holds torchao quantizations, about 4.5 GB, which
# it does not.
ANIME = {"repository": "phasefield-audio/Irodori-TTS-v4.1-Anime", "revision": "6b259f5baa5e236b3d14cbd1f8555ca87d92b530",
         "files": {"model.safetensors": (3064295596, "5630aa0a661930ff678a1d1f1893876e24520f4776d4fcc25ca54e6ab9f41f37"),
                   "README.md": (1011, "28bd916a1312c4da901cfaf5bb4476cad5b9b21595e6514b2326707e8c82d773"),
                   "tokenizer/tokenizer.json": (6718495, "6a0734cf21c802169defaffe719bc2ef12bb9d0be37e54b61ed27aa89394723d"),
                   "tokenizer/tokenizer_config.json": (668, "d229a271c64de1a7939d20d3665498e873fa91d5ee2edf135d73ec752cb9c9d3")}}
# The packages the conversion imports, at the versions of the uv.lock of speech.cpp's converter (reference/irodori-tts
# at the commit below), with the hashes of their wheels for Python 3.10 on macOS (Apple Silicon) and Windows (x64).
REQUIREMENTS = """\
numpy==2.2.6 \\
    --hash=sha256:8e41fd67c52b86603a91c1a505ebaef50b3314de0213461c7a6e99c9a3beff90 \\
    --hash=sha256:37e990a01ae6ec7fe7fa1c26c55ecb672dd98b19c3d0e1d1f326fa13cb38d163 \\
    --hash=sha256:f0fd6321b839904e15c46e0d257fdd101dd7f530fe03fd6359c1ea63738703f3
safetensors==0.8.0 \\
    --hash=sha256:c80201d22cbf405b80647a60ada77bba06c8fba2da2743ba1e89cdcc39a81f25 \\
    --hash=sha256:096ec1a98435df7beb08853bb5aa9081a84f23d0adc67ed1a0a10550f608373f
gguf==0.19.0 \\
    --hash=sha256:70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd
pyyaml==6.0.3 \\
    --hash=sha256:02ea2dfa234451bbb8772601d7b8e426c2bfa197136796224e50e35a78777956 \\
    --hash=sha256:bdb2c67c6c1390b63c6ff89f210c8fd09d9a1217a465701eac7316313c915e4c
"""
TYPES = ("q4_k", "q5_k", "q6_k", "q8_0", "f16")
F32_FILE = "Irodori-TTS-859M-Anime-v4.1-F32.gguf"
# Free space a run from nothing takes at its peak: the checkpoint, the F32 file, the result and Python.
NEEDED_BYTES = 9e9


# ---------------------------------------------------------------------------------------------------- the conversion
# convert() is derived from reference/irodori-tts/convert.py of speech.cpp
# (https://github.com/nyosegawa/speech.cpp at 03555100287c118b41d1b475044e5ab1e07baa8c), which is under this license:
#
#   MIT License
#
#   Copyright (c) 2026 Sakasegawa
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
#   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
#   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
#   permit persons to whom the Software is furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
#   the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
#   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
#   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.
#
# It keeps the path the Anime fine-tune takes: ModernBERT-ja's text backbone, rectified flow, a caption condition and
# a Unigram tokenizer. Where convert.py loads the codec with dacvae and reads the runtime's defaults from irodori-tts,
# convert() takes them from the Small model, into which the same converter wrote them; the file it writes is the one
# convert.py writes, in layout 3.
def convert(checkpoint_dir, small_path, out_dir):
    import numpy as np
    import yaml
    from gguf import GGUFReader, GGUFValueType, GGUFWriter, LlamaFileType, naming_convention, size_label
    from safetensors import safe_open

    arch = "irodori-tts"
    # The layout convert.py writes, and the first release of speech.cpp whose reader takes it.
    layout, requires = 3, "0.8.7"
    # The bounds of OpenAI's speed, which Irodori-TTS-Server takes and divides the length by.
    min_speed, max_speed = 0.25, 4.0
    repository_id = ANIME["repository"]
    revision = ANIME["revision"]

    small = GGUFReader(small_path)

    def small_value(key):
        return small.fields[key].contents()

    checkpoint = safe_open(os.path.join(checkpoint_dir, "model.safetensors"), "np")
    config = json.loads(checkpoint.metadata()["config_json"])
    text_config = json.loads(checkpoint.metadata()["text_encoder_config_json"])
    assert config["text_encoder_type"] == "pretrained" and text_config["model_type"] == "modernbert"
    assert config["pretrained_projector_type"] == "residual_mlp" and config["latent_patch_size"] == 1
    assert config.get("flow_parameterization", "rf_velocity") == "rf_velocity" == small_value(arch + ".flow")
    with open(os.path.join(checkpoint_dir, "README.md"), encoding="utf-8") as f:
        card = yaml.safe_load(f.read().split("---\n")[1])
    assert small_value(arch + ".latent_dim") == int(config["latent_dim"]), "the model's latent is not the codec's"

    w = GGUFWriter(None, arch)

    def add_array(key, values, element):
        """An array with its element type given, not inferred from its first value."""
        w.add_key_value(key, list(values), GGUFValueType.ARRAY, sub_type=element)

    w.add_uint32("speech.layout", layout)
    w.add_string("speech.requires", requires)
    w.add_string("speech.task", "synthesis")
    w.add_uint32("speech.sample_rate", int(small_value("speech.sample_rate")))
    # Irodori-TTS takes no language with a request; a request's language is only checked against the model's.
    w.add_string("speech.language_use", "checked")

    p = arch + "."
    w.add_string(p + "flow", "rf_velocity")
    w.add_uint32(p + "latent_dim", int(config["latent_dim"]))
    w.add_float32(p + "norm_eps", float(config["norm_eps"]))
    # The RoPE base of the speaker encoder and the DiT.
    w.add_float32(p + "rope_theta", float(small_value(p + "rope_theta")))

    w.add_string(p + "text.backbone", "modernbert")
    w.add_uint32(p + "text.hidden_size", int(text_config["hidden_size"]))
    w.add_uint32(p + "text.num_heads", int(text_config["num_attention_heads"]))
    w.add_uint32(p + "text.num_layers", int(text_config["num_hidden_layers"]))
    add_array(p + "text.layer_global", [int(t == "full_attention") for t in text_config["layer_types"]],
              GGUFValueType.INT32)
    w.add_float32(p + "text.rope_theta_global", float(text_config["rope_parameters"]["full_attention"]["rope_theta"]))
    w.add_float32(p + "text.rope_theta_local",
                  float(text_config["rope_parameters"]["sliding_attention"]["rope_theta"]))
    assert text_config["hidden_activation"] == "gelu" and not text_config["norm_bias"]
    assert not text_config["attention_bias"] and not text_config["mlp_bias"]
    w.add_float32(p + "text.norm_eps", float(text_config["norm_eps"]))
    # A local layer attends to the tokens at most local_attention / 2 away on either side.
    w.add_uint32(p + "text.window", int(text_config["local_attention"]) // 2)
    w.add_uint32(p + "text.dim", int(config["text_dim"]))
    w.add_uint32(p + "text.max_tokens", int(config["max_text_len"]))

    w.add_uint32(p + "speaker.dim", int(config["speaker_dim"]))
    w.add_uint32(p + "speaker.num_layers", int(config["speaker_layers"]))
    w.add_uint32(p + "speaker.num_heads", int(config["speaker_heads"]))
    w.add_uint32(p + "speaker.patch_size", int(config["speaker_patch_size"]))
    assert config["duration_architecture"] == "token_sum_dual_adarn_zero_no_aux"
    w.add_uint32(p + "duration.num_layers", int(config["duration_layers"]))
    # The predictor's speaker when a request has no reference, which a checkpoint of a speaker condition holds.
    null_speaker = "duration_predictor.null_speaker" in checkpoint.keys()
    w.add_bool(p + "duration.null_speaker", null_speaker)
    # The caption condition: the shared text backbone with the caption's own projector and norm.
    caption = bool(config["use_caption_condition"])
    caption_dim = int(config["text_dim"] if config.get("caption_dim") is None else config["caption_dim"])
    w.add_uint32(p + "caption.dim", caption_dim)
    w.add_bool(p + "caption_condition", caption)
    if caption:
        assert config["caption_tokenizer_repo"] in (None, config["text_tokenizer_repo"])
        assert config["caption_add_bos"] in (None, config["text_add_bos"]) and config["text_add_bos"]
        assert config["duration_caption_fusion"] == "adarn_zero" and config["duration_caption_pooling"] == "masked_mean"
        w.add_uint32(p + "caption.max_tokens", int(config["max_caption_len"]))
    w.add_uint32(p + "dit.dim", int(config["model_dim"]))
    w.add_uint32(p + "dit.num_layers", int(config["num_layers"]))
    w.add_uint32(p + "dit.num_heads", int(config["num_heads"]))
    w.add_uint32(p + "dit.timestep_dim", int(config["timestep_embed_dim"]))

    # The official runtime's sampling, length, reference and tail defaults.
    w.add_uint32(p + "sampler.default_steps", int(small_value(p + "sampler.default_steps")))
    for key in ("sampler.cfg_text", "sampler.cfg_speaker", "sampler.cfg_min_t", "sampler.cfg_max_t",
                "sampler.speaker_kv_min_t") + (("sampler.cfg_caption",) if caption else ()):
        w.add_float32(p + key, float(small_value(p + key)))
    w.add_float32(p + "length.min_seconds", float(small_value(p + "length.min_seconds")))
    w.add_float32(p + "length.max_seconds", float(small_value(p + "length.max_seconds")))
    w.add_float32(p + "length.min_speed", min_speed)
    w.add_float32(p + "length.max_speed", max_speed)
    w.add_float32(p + "reference.max_seconds", float(config["ref_max_seconds"]))
    w.add_float32(p + "reference.lufs", float(small_value(p + "reference.lufs")))
    w.add_uint32(p + "tail.window", int(small_value(p + "tail.window")))
    w.add_float32(p + "tail.std_threshold", float(small_value(p + "tail.std_threshold")))
    w.add_float32(p + "tail.mean_threshold", float(small_value(p + "tail.mean_threshold")))

    # The SentencePiece tokenizer: ModernBERT-ja's Unigram model, with its scores in float64 as tokenizer.json has
    # them, since the Viterbi path compares their sums.
    with open(os.path.join(checkpoint_dir, "tokenizer", "tokenizer.json"), encoding="utf-8") as f:
        tokenizer = json.load(f)
    model = tokenizer["model"]
    assert model["type"] == "Unigram" and model["byte_fallback"] and tokenizer["normalizer"] is None
    assert tokenizer["pre_tokenizer"] == {"type": "Metaspace", "replacement": "▁", "prepend_scheme": "never",
                                          "split": False}
    tokens = [piece for piece, _ in model["vocab"]]
    for added in tokenizer["added_tokens"]:
        assert tokens[added["id"]] == added["content"] and not added["normalized"]
        assert not (added["lstrip"] or added["rstrip"] or added["single_word"])
    with open(os.path.join(checkpoint_dir, "tokenizer", "tokenizer_config.json"), encoding="utf-8") as f:
        tokenizer_config = json.load(f)
    w.add_string(p + "tokenizer.model", "unigram")
    add_array(p + "tokenizer.tokens", tokens, GGUFValueType.STRING)
    add_array(p + "tokenizer.scores", [float(score) for _, score in model["vocab"]], GGUFValueType.FLOAT64)
    add_array(p + "tokenizer.added_ids", [int(added["id"]) for added in tokenizer["added_tokens"]],
              GGUFValueType.INT32)
    w.add_uint32(p + "tokenizer.bos_id", tokens.index(tokenizer_config["bos_token"]))
    w.add_uint32(p + "tokenizer.unknown_id", int(model["unk_id"]))

    w.add_uint32(p + "codec.hop_length", int(small_value(p + "codec.hop_length")))
    add_array(p + "codec.encoder_rates", small_value(p + "codec.encoder_rates"), GGUFValueType.INT32)
    add_array(p + "codec.decoder_rates", small_value(p + "codec.decoder_rates"), GGUFValueType.INT32)
    w.add_string(p + "codec.sha256", small_value(p + "codec.sha256"))

    # The checkpoint's tensors the file holds, every one of them by the end.
    converted = set()

    def tensor(key):
        converted.add(key)
        return checkpoint.get_tensor(key).astype(np.float32)

    def each_tensor(add):
        """Gives add() each tensor of the file, in its order. convert.py holds every tensor in memory until it writes
        the file; this runs twice instead, for the tensors' shapes and then for their data, so that only one tensor is
        in memory at a time."""
        # ModernBERT-ja: the fused query, key and value projection is split, and so is the MLP's input projection into
        # the half that goes through GELU and the half that gates it.
        b = "pretrained_text_backbone.backbone."
        hidden = int(text_config["hidden_size"])
        inner = int(text_config["intermediate_size"])
        add("text.embd", tensor(b + "embeddings.tok_embeddings.weight"))
        add("text.embd_norm", tensor(b + "embeddings.norm.weight"))
        for i in range(int(text_config["num_hidden_layers"])):
            a, o = f"{b}layers.{i}.", f"text.blk.{i}."
            if i > 0:
                add(o + "attn_norm", tensor(a + "attn_norm.weight"))
            qkv = tensor(a + "attn.Wqkv.weight")
            add(o + "attn_q", qkv[:hidden])
            add(o + "attn_k", qkv[hidden: 2 * hidden])
            add(o + "attn_v", qkv[2 * hidden:])
            add(o + "attn_out", tensor(a + "attn.Wo.weight"))
            add(o + "ffn_norm", tensor(a + "mlp_norm.weight"))
            wi = tensor(a + "mlp.Wi.weight")
            add(o + "ffn_act", wi[:inner])
            add(o + "ffn_gate", wi[inner:])
            add(o + "ffn_down", tensor(a + "mlp.Wo.weight"))
        add("text.final_norm", tensor(b + "final_norm.weight"))

        def projector(source, out):
            """A PretrainedConditionProjector of the backbone's output: a linear map plus an RMS-normed residual
            MLP."""
            add(out + ".weight", tensor(source + "projector.weight"))
            add(out + ".bias", tensor(source + "projector.bias"))
            add(out + ".res_norm", tensor(source + "residual_norm.weight"))
            add(out + ".res_up.weight", tensor(source + "residual_up.weight"))
            add(out + ".res_up.bias", tensor(source + "residual_up.bias"))
            add(out + ".res_down.weight", tensor(source + "residual_down.weight"))
            add(out + ".res_down.bias", tensor(source + "residual_down.bias"))

        projector("text_encoder.", "text.proj")
        add("text.norm", tensor("text_norm.weight"))
        if caption:
            projector("caption_encoder.", "caption.proj")
            add("caption.norm", tensor("caption_norm.weight"))

        def swiglu(prefix_in, prefix_out):
            add(prefix_out + "ffn_gate", tensor(prefix_in + "w1.weight"))
            add(prefix_out + "ffn_up", tensor(prefix_in + "w3.weight"))
            add(prefix_out + "ffn_down", tensor(prefix_in + "w2.weight"))

        # The speaker encoder: a pre-norm transformer on the reference latent in patches of four frames.
        add("speaker.in_proj.weight", tensor("speaker_encoder.in_proj.weight"))
        add("speaker.in_proj.bias", tensor("speaker_encoder.in_proj.bias"))
        for i in range(int(config["speaker_layers"])):
            a, o = f"speaker_encoder.blocks.{i}.", f"speaker.blk.{i}."
            add(o + "attn_norm", tensor(a + "attention_norm.weight"))
            for x in ("q", "k", "v", "o"):
                add(o + f"attn_{x}", tensor(a + f"attention.w{x}.weight"))
            add(o + "attn_gate", tensor(a + "attention.gate.weight"))
            add(o + "q_norm", tensor(a + "attention.q_norm.weight"))
            add(o + "k_norm", tensor(a + "attention.k_norm.weight"))
            add(o + "ffn_norm", tensor(a + "mlp_norm.weight"))
            swiglu(a + "mlp.", o)
        add("speaker.norm", tensor("speaker_norm.weight"))

        # The duration predictor; without a caption its caption vector is the learned null one, and without a reference
        # its speaker vector.
        d = "duration_predictor."
        add("duration.in_proj.weight", tensor(d + "token_input_proj.weight"))
        add("duration.in_proj.bias", tensor(d + "token_input_proj.bias"))
        for i in range(int(config["duration_layers"])):
            a, o = f"{d}token_blocks.{i}.", f"duration.blk.{i}."
            add(o + "norm", tensor(a + "norm.weight"))
            add(o + "mod.weight", tensor(a + "modulation.weight"))
            add(o + "mod.bias", tensor(a + "modulation.bias"))
            add(o + "caption_mod.weight", tensor(a + "caption_modulation.weight"))
            add(o + "caption_mod.bias", tensor(a + "caption_modulation.bias"))
            swiglu(a + "mlp.", o)
        add("duration.out_norm", tensor(d + "token_out_norm.weight"))
        add("duration.out_proj.weight", tensor(d + "token_out_proj.weight"))
        add("duration.out_proj.bias", tensor(d + "token_out_proj.bias"))
        add("duration.null_caption", tensor(d + "null_caption"))
        if null_speaker:
            add("duration.null_speaker", tensor(d + "null_speaker"))

        # The DiT.
        for i, layer_index in enumerate((0, 2, 4)):
            add(f"dit.cond.{i}", tensor(f"cond_module.{layer_index}.weight"))
        add("dit.in_proj.weight", tensor("in_proj.weight"))
        add("dit.in_proj.bias", tensor("in_proj.bias"))
        for i in range(int(config["num_layers"])):
            a, o = f"blocks.{i}.", f"dit.blk.{i}."
            for x in ("q", "k", "v", "o"):
                add(o + f"attn_{x}", tensor(a + f"attention.w{x}.weight"))
            add(o + "attn_gate", tensor(a + "attention.gate.weight"))
            for x in ("k", "v"):
                add(o + f"attn_{x}_text", tensor(a + f"attention.w{x}_text.weight"))
                add(o + f"attn_{x}_speaker", tensor(a + f"attention.w{x}_speaker.weight"))
                if caption:
                    add(o + f"attn_{x}_caption", tensor(a + f"attention.w{x}_caption.weight"))
            add(o + "q_norm", tensor(a + "attention.q_norm.weight"))
            add(o + "k_norm", tensor(a + "attention.k_norm.weight"))
            swiglu(a + "mlp.", o)
            for ada, out in (("attention_adaln", "attn_ada"), ("mlp_adaln", "ffn_ada")):
                for part in ("shift", "scale", "gate"):
                    add(o + f"{out}.{part}.down", tensor(a + f"{ada}.{part}_down.weight"))
                    add(o + f"{out}.{part}.up.weight", tensor(a + f"{ada}.{part}_up.weight"))
                    add(o + f"{out}.{part}.up.bias", tensor(a + f"{ada}.{part}_up.bias"))
        add("dit.out_norm", tensor("out_norm.weight"))
        add("dit.out_proj.weight", tensor("out_proj.weight"))
        add("dit.out_proj.bias", tensor("out_proj.bias"))

        # The codec, in float32 in the Small model as in every file of the model.
        for t in small.tensors:
            if t.name.startswith("codec."):
                assert t.tensor_type.name == "F32"
                add(t.name, t.data)

    def plan(name, data):
        data = np.ascontiguousarray(data, dtype=np.float32)
        w.add_tensor_info(name, data.shape, data.dtype, data.nbytes)

    each_tensor(plan)
    assert converted == set(checkpoint.keys()), sorted(set(checkpoint.keys()) - converted)

    # The model's identity and languages in the GGUF specification's general keys, which name the file. They follow
    # the tensors, whose parameters give the size label, and then go first after general.architecture.
    label = size_label(*w.get_total_parameter_count())
    repository = f"https://huggingface.co/{repository_id}"
    w.add_name(repository_id.split("/")[1])
    w.add_organization(repository_id.split("/")[0])
    w.add_basename("Irodori-TTS")
    w.add_size_label(label)
    w.add_finetune("Anime")
    w.add_version("v4.1")
    w.add_license({"mit": "MIT"}[card["license"]])
    w.add_source_url(f"{repository}/tree/{revision}")
    w.add_source_repo_url(repository)
    w.add_file_type(LlamaFileType.ALL_F32)
    # The Anime card omits its language.
    w.add_languages(sorted(card.get("language", ["ja"])))
    w.kv_data[0] = dict(sorted(w.kv_data[0].items(), key=lambda item: not item[0].startswith("general.")))

    path = os.path.join(out_dir, naming_convention(None, "Irodori-TTS", "Anime", "v4.1", label, "f32") + ".gguf")
    w.write_header_to_file(path)
    w.write_kv_data_to_file()
    w.write_ti_data_to_file()
    each_tensor(lambda name, data: w.write_tensor_data(np.ascontiguousarray(data, dtype=np.float32)))
    w.close()


# ---------------------------------------------------------------------------------------------------------- the steps
class Failure(Exception):
    pass


def gb(n):
    return f"{n / 1e9:.1f} GB"


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url, path, size, sha256):
    """A file is moved to its path only once its size and SHA-256 match, so a file at the path is complete. An
    interrupted download resumes."""
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    if part.exists() and part.stat().st_size > size:
        part.unlink()
    if not part.exists() or part.stat().st_size < size:
        large = size > 50e6
        print(f"  {path.name}（{gb(size)}）" if large else f"  {path.name}", flush=True)
        for attempt in range(2):
            code = subprocess.run([str(CURL), "--fail", "--location", "--retry", "5", "--retry-delay", "3",
                                   "--progress-bar" if large else "--silent", "--show-error",
                                   "--continue-at", "-", "--output", str(part), url]).returncode
            # 33: the server does not resume; start again from nothing once.
            if code == 33 and attempt == 0:
                part.unlink(missing_ok=True)
                continue
            if code != 0:
                raise Failure(f"{path.name} をダウンロードできませんでした。ネットワークを確認して、もう一度実行してください")
            break
    if part.stat().st_size != size or sha256_of(part) != sha256:
        part.unlink()
        raise Failure(f"{path.name} の中身が想定と違いました。もう一度実行してください")
    part.replace(path)


def run(args, what, **options):
    try:
        code = subprocess.run([str(a) for a in args], **options).returncode
    except OSError:
        raise Failure(f"{what}を始められませんでした")
    if code != 0:
        raise Failure(f"{what}に失敗しました（終了コード {code}）。もう一度実行すると、済んだところから続けます")


def only_gguf(folder):
    files = list(folder.glob("*.gguf"))
    if len(files) != 1:
        raise Failure(f"{folder} にできるはずのファイルがありません")
    return files[0]


def mini():
    """Mini's speech and Small model: in the package's folder, or in the source tree after npm run package:speech and
    npm run package:model."""
    for speech, small in ((ROOT / "runtime" / "speech" / f"speech{EXE}", ROOT / "runtime" / "models" / SMALL["file"]),
                          (ROOT / ".packaging" / "speech-runtime" / f"speech{EXE}",
                           ROOT / ".packaging" / "model" / SMALL["file"])):
        if speech.exists() and small.exists():
            if small.stat().st_size != SMALL["size"] or sha256_of(small) != SMALL["sha256"]:
                raise Failure(f"Miniの音声モデルが想定と違います（{small}）")
            return speech, small
    raise Failure("TRPG Voice Bridge Miniのフォルダ（trpg-voice-bridge-miniがあるフォルダ）に置いて実行してください")


def main():
    parser = argparse.ArgumentParser(description="Irodori-TTS-v4.1-AnimeのGGUFを、このフォルダに作ります")
    parser.add_argument("--type", choices=TYPES, default="q4_k", help="量子化の種類（既定 q4_k）")
    parser.add_argument("--keep-work", action="store_true", help="できたあとも work/ を残す")
    args = parser.parse_args()

    result = ROOT / f"Irodori-TTS-859M-Anime-v4.1-{args.type.upper()}.gguf"
    if result.exists():
        print(f"もうできています: {result}")
        if not args.keep_work and WORK.exists():
            (WORK / ".done").write_text("", "utf-8")
        return
    if not UV.exists():
        raise Failure("make-anime-model.sh（macOS）か make-anime-model.bat（Windows）から実行してください")
    speech, small = mini()
    f32 = WORK / "out" / F32_FILE
    free = shutil.disk_usage(ROOT).free
    if not f32.exists() and free < NEEDED_BYTES:
        raise Failure(f"空き容量が足りません。{ROOT} のあるドライブに {gb(NEEDED_BYTES)} 以上の空きが要ります（今は {gb(free)}）")

    print(f"Anime版のモデル（{args.type}）を作ります。作業ファイルは {WORK} に置きます。", flush=True)
    tmp = WORK / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not re.match(r"(PYTHON|VIRTUAL_ENV|CONDA|PIP_)", k, re.I)}
    env.update(PYTHONNOUSERSITE="1", TMPDIR=str(tmp), TMP=str(tmp), TEMP=str(tmp),
               UV_CACHE_DIR=str(WORK / "uv-cache"), UV_PYTHON_INSTALL_DIR=str(WORK / "python"),
               UV_PYTHON_BIN_DIR=str(WORK / "python" / "bin"), UV_PYTHON_PREFERENCE="only-managed",
               UV_PYTHON_INSTALL_REGISTRY="0", UV_NO_CONFIG="1")

    print("1/4 変換に使うPythonのパッケージを入れます", flush=True)
    venv = WORK / "venv"
    python = venv / ("Scripts/python.exe" if WINDOWS else "bin/python")
    stamp = venv / "bridge-mini-requirements.txt"
    if not stamp.exists() or stamp.read_text("utf-8") != REQUIREMENTS:
        shutil.rmtree(venv, ignore_errors=True)
        (WORK / "requirements.txt").write_text(REQUIREMENTS, "utf-8")
        run([UV, "venv", "--quiet", "--python", "3.10", venv], "Pythonの用意", env=env)
        run([UV, "pip", "sync", "--quiet", "--require-hashes", "--python", python, WORK / "requirements.txt"],
            "パッケージのインストール", env=env)
        stamp.write_text(REQUIREMENTS, "utf-8")

    print("2/4 Anime版のチェックポイントをダウンロードします（3.1 GB）", flush=True)
    checkpoint = WORK / "anime"
    for name, (size, sha256) in ANIME["files"].items():
        download(f"https://huggingface.co/{ANIME['repository']}/resolve/{ANIME['revision']}/{name}",
                 checkpoint / name, size, sha256)

    print("3/4 F32のGGUFに変換します", flush=True)
    if not f32.exists():
        out = tmp / "convert"
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        run([python, Path(__file__).resolve(), "convert", checkpoint, small, out], "F32への変換", env=env)
        f32.parent.mkdir(parents=True, exist_ok=True)
        only_gguf(out).replace(f32)

    print(f"4/4 {args.type}に量子化します", flush=True)
    out = tmp / "quantize"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    run([speech, "quantize", f32, out, "--type", args.type], f"{args.type}への量子化")
    quantized = only_gguf(out)
    info = subprocess.run([str(speech), "info", str(quantized)], capture_output=True, text=True, encoding="utf-8")
    if info.returncode != 0 or not re.search(r"^architecture\s+irodori-tts\b", info.stdout, re.M) \
            or not re.search(r"^finetune\s+Anime$", info.stdout, re.M):
        raise Failure("できたファイルを音声生成で読めませんでした")
    quantized.replace(result)

    print(f"できました: {result}")
    if args.keep_work:
        print(f"作業ファイルは {WORK} に残しています")
    else:
        # The launcher removes work/ once this has ended, since uv and this Python run from it.
        (WORK / ".done").write_text("", "utf-8")


if __name__ == "__main__":
    if sys.argv[1:2] == ["convert"]:
        # Run by main() in work/venv, which has the packages.
        convert(*sys.argv[2:5])
    else:
        try:
            main()
        except Failure as error:
            print(error, file=sys.stderr)
            sys.exit(1)
        except KeyboardInterrupt:
            print("中断しました。もう一度実行すると、済んだところから続けます", file=sys.stderr)
            sys.exit(130)
