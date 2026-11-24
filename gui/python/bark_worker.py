import json
import os
import sys
import traceback
from pathlib import Path

# Reserve real stdout exclusively for structured JSON-line IPC responses.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

import torch
from scipy.io.wavfile import write as write_wav

# PyTorch 2.6+ defaults torch.load(..., weights_only=True), which rejects
# legacy pickled objects inside Suno Bark's .pt checkpoints.
_original_torch_load = torch.load


def _compat_torch_load(*args, **kwargs):
    if "weights_only" not in kwargs:
        kwargs["weights_only"] = False
    return _original_torch_load(*args, **kwargs)


torch.load = _compat_torch_load


def emit(payload: dict) -> None:
    _REAL_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


_models_loaded = False
_loaded_small = False
_loaded_offload = False


def ensure_models(use_small_models: bool, offload_cpu: bool, job_id: str | None = None) -> None:
    global _models_loaded, _loaded_small, _loaded_offload

    os.environ["SUNO_USE_SMALL_MODELS"] = "True" if use_small_models else "False"
    os.environ["SUNO_OFFLOAD_CPU"] = "True" if offload_cpu else "False"

    import bark.generation as bg

    bg.USE_SMALL_MODELS = use_small_models
    bg.OFFLOAD_CPU = offload_cpu

    if not _models_loaded or _loaded_small != use_small_models or _loaded_offload != offload_cpu:
        emit({"type": "status", "id": job_id, "stage": "loading"})
        bg.preload_models(
            text_use_small=use_small_models,
            coarse_use_small=use_small_models,
            fine_use_small=use_small_models,
            force_reload=_models_loaded,
        )
        _models_loaded = True
        _loaded_small = use_small_models
        _loaded_offload = offload_cpu


def handle_generate(req: dict) -> None:
    job_id = req.get("id")
    text = (req.get("text") or "").strip()
    if not text:
        emit({"type": "result", "id": job_id, "ok": False, "error": "Text prompt cannot be empty."})
        return

    history_prompt = req.get("history_prompt") or None
    text_temp = float(req.get("text_temp", 0.7))
    waveform_temp = float(req.get("waveform_temp", 0.7))
    use_small_models = bool(req.get("use_small_models", False))
    offload_cpu = bool(req.get("offload_cpu", False))
    save_prompt_npz = bool(req.get("save_prompt_npz", False))

    output_dir = Path(req.get("output_dir") or ".")
    output_filename = (req.get("output_filename") or "bark_generation.wav").strip()
    if not output_filename.lower().endswith(".wav"):
        output_filename += ".wav"

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / output_filename

    ensure_models(use_small_models, offload_cpu, job_id=job_id)

    emit({"type": "status", "id": job_id, "stage": "generating"})
    from bark import SAMPLE_RATE, generate_audio, save_as_prompt

    if save_prompt_npz:
        full_generation, audio_array = generate_audio(
            text,
            history_prompt=history_prompt,
            text_temp=text_temp,
            waveform_temp=waveform_temp,
            silent=False,
            output_full=True,
        )
        prompt_path = output_path.with_suffix(".npz")
        save_as_prompt(str(prompt_path), full_generation)
    else:
        audio_array = generate_audio(
            text,
            history_prompt=history_prompt,
            text_temp=text_temp,
            waveform_temp=waveform_temp,
            silent=False,
            output_full=False,
        )
        prompt_path = None

    emit({"type": "status", "id": job_id, "stage": "saving"})
    write_wav(str(output_path), SAMPLE_RATE, audio_array)

    duration_seconds = float(len(audio_array)) / float(SAMPLE_RATE)
    emit(
        {
            "type": "result",
            "id": job_id,
            "ok": True,
            "output_path": str(output_path),
            "prompt_path": str(prompt_path) if prompt_path else None,
            "duration_seconds": duration_seconds,
            "sample_rate": int(SAMPLE_RATE),
        }
    )


def main() -> None:
    cuda_available = torch.cuda.is_available()
    device_name = torch.cuda.get_device_name(0) if cuda_available else "CPU"
    emit(
        {
            "type": "ready",
            "cuda": cuda_available,
            "device": device_name,
            "torch": torch.__version__,
        }
    )

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "ping":
                emit({"type": "pong", "cuda": cuda_available, "device": device_name})
            elif cmd == "preload":
                ensure_models(
                    bool(req.get("use_small_models", False)),
                    bool(req.get("offload_cpu", False)),
                    job_id=req.get("id"),
                )
                emit({"type": "preloaded", "id": req.get("id"), "ok": True})
            elif cmd == "generate":
                handle_generate(req)
            elif cmd == "shutdown":
                break
            else:
                emit({"type": "error", "id": req.get("id"), "error": f"Unknown command: {cmd}"})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            emit(
                {
                    "type": "result" if (req and req.get("cmd") == "generate") else "error",
                    "id": req.get("id") if isinstance(req, dict) else None,
                    "ok": False,
                    "error": str(exc),
                }
            )


if __name__ == "__main__":
    main()
