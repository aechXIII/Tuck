from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Callable
from pathlib import Path

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table
from rich.theme import Theme

from . import __version__

_THEME = Theme(
    {
        "brand": "bold cyan",
        "accent": "bold magenta",
        "muted": "dim white",
        "success": "bold green",
        "error": "bold red",
    }
)
console = Console(theme=_THEME)
error_console = Console(stderr=True, theme=_THEME)


def _table(title: str, *, show_header: bool = True) -> Table:
    return Table(
        title=title,
        box=box.ROUNDED,
        border_style="brand",
        header_style="brand",
        title_style="brand",
        show_header=show_header,
        pad_edge=True,
    )


def _print_queue_header(profile, total: int) -> None:
    workflow = profile.workflow.upper()
    console.print(
        Panel.fit(
            f"[brand]TUCK[/brand] [muted]//[/muted] [accent]{workflow}[/accent]\n"
            f"[muted]{total} file{'s' if total != 1 else ''} | {profile.name}[/muted]",
            border_style="brand",
            padding=(0, 2),
        )
    )


logger = logging.getLogger(__name__)


def main(argv: list[str] | None = None) -> int:

    parser = _build_parser()
    args = parser.parse_args(argv)

    _setup_logging(args.verbose)

    if args.version:
        print(f"Tuck {__version__}")
        return 0

    # Handlers are defined below
    handlers: dict[str, Callable[[argparse.Namespace], int]] = {
        "probe": _cmd_probe,
        "compress": _cmd_process,
        "upscale": _cmd_process,
        "profiles": _cmd_profiles,
        "settings": _cmd_settings,
        "sendto": _cmd_sendto,
    }
    handler = handlers.get(args.command)
    if handler is None:
        parser.print_help()
        return 0
    return handler(args)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tuck",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Increase verbosity (-v, -vv)",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Show version and exit",
    )
    sub = parser.add_subparsers(dest="command")

    p_probe = sub.add_parser("probe", help="Probe a video file")
    p_probe.add_argument("file", help="Video file to probe")
    p_probe.add_argument("--json", action="store_true", help="Output as JSON")

    p_compress = sub.add_parser("compress", help="Compress video files to a size limit")
    p_compress.add_argument("files", nargs="+", help="Video files to compress")
    p_compress.add_argument(
        "--profile",
        "-p",
        default="discord-10mb",
        help="Compression profile (default: discord-10mb)",
    )
    p_compress.add_argument("--size", type=float, help="Target file size in MB (overrides profile)")
    p_compress.add_argument("--output", "-o", help="Output path (single file mode only)")
    p_compress.add_argument(
        "--review", action="store_true", help="Show plan and confirm before processing"
    )

    p_upscale = sub.add_parser("upscale", help="Upscale video files")
    p_upscale.add_argument("files", nargs="+", help="Video files to upscale")
    upscale_target = p_upscale.add_mutually_exclusive_group(required=True)
    upscale_target.add_argument("--to", choices=("1440p", "4k"), help="Target resolution preset")
    upscale_target.add_argument("--resolution", help="Target resolution, for example 2560x1440")
    upscale_target.add_argument("--profile", "-p", help="Upscale profile")
    p_upscale.add_argument("--output", "-o", help="Output path (single file mode only)")
    p_upscale.add_argument(
        "--review", action="store_true", help="Show plan and confirm before processing"
    )

    p_prof = sub.add_parser("profiles", help="Manage profiles")
    p_prof_sub = p_prof.add_subparsers(dest="profiles_cmd")
    p_prof_sub.add_parser("list", help="List profiles")
    p_prof_export = p_prof_sub.add_parser("export", help="Export profiles to JSON")
    p_prof_export.add_argument("output", help="Output JSON file")
    p_prof_import = p_prof_sub.add_parser("import", help="Import profiles from JSON")
    p_prof_import.add_argument("file", help="Input JSON file")

    p_set = sub.add_parser("settings", help="Manage settings")
    p_set_sub = p_set.add_subparsers(dest="settings_cmd")
    p_set_sub.add_parser("show", help="Show current settings")
    p_set_sub.add_parser("reset", help="Reset to defaults")

    p_st = sub.add_parser("sendto", help="Manage Send To shortcuts")
    p_st_sub = p_st.add_subparsers(dest="sendto_cmd")
    p_st_sub.add_parser("install", help="Install Send To shortcut")
    p_st_sub.add_parser("uninstall", help="Remove Send To shortcut")
    p_st_sub.add_parser("uninstall-all", help="Remove all Send To shortcuts")
    p_st_sub.add_parser("repair", help="Repair Send To shortcut")

    return parser


def _setup_logging(verbosity: int) -> None:
    level = logging.WARNING
    if verbosity >= 2:
        level = logging.DEBUG
    elif verbosity == 1:
        level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _probe_info_json(info) -> dict:
    from .bridge_serialization import video_info_dict

    full = video_info_dict(info)
    return {
        key: full[key]
        for key in (
            "path",
            "duration",
            "width",
            "height",
            "fps",
            "video_codec",
            "audio_codec",
            "audio_channels",
            "file_size",
            "file_size_mb",
            "bitrate_kbps",
        )
    }


def _print_probe_table(info) -> None:
    table = _table("VIDEO DETAILS", show_header=False)
    table.add_column(style="cyan")
    table.add_column()
    table.add_row("File", str(info.path))
    table.add_row("Duration", info.duration_str)
    table.add_row("Resolution", info.resolution_str)
    table.add_row("FPS", f"{info.fps:.2f}")
    table.add_row("Video", info.video_codec)
    audio = (
        f"{info.audio_codec} ({info.audio_channels}ch, {info.audio_sample_rate}Hz)"
        if info.has_audio
        else "none"
    )
    table.add_row("Audio", audio)
    table.add_row("Size", f"{info.file_size / (1024 * 1024):.1f} MB")
    if info.bitrate:
        table.add_row("Bitrate", f"{info.bitrate / 1000:.0f} kbps")
    console.print(table)


def _cmd_probe(args) -> int:
    from .probe import is_ffprobe_available
    from .probe import probe as probe_video

    if not is_ffprobe_available():
        print("Error: ffprobe not found. Install FFmpeg.", file=sys.stderr)
        return 2

    try:
        info = probe_video(args.file)
        if args.json:
            import json as _json

            print(_json.dumps(_probe_info_json(info), indent=2))
        else:
            _print_probe_table(info)
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


def _compute_profile_id(args) -> str:
    from .models import PROFILE_ID_4K_UPSCALE, PROFILE_ID_1440P_UPSCALE

    if args.command == "upscale" and args.to:
        return {"1440p": PROFILE_ID_1440P_UPSCALE, "4k": PROFILE_ID_4K_UPSCALE}[args.to]
    if args.command == "upscale" and args.resolution:
        return PROFILE_ID_1440P_UPSCALE
    return args.profile


def _resolve_profile(args, profiles):
    from .models import WORKFLOW_COMPRESSION, WORKFLOW_UPSCALE, find_profile_by_id

    profile_id = _compute_profile_id(args)
    profile = find_profile_by_id(profiles, profile_id)
    if args.command == "upscale" and args.resolution and profile:
        try:
            profile = _profile_with_resolution(profile, args.resolution)
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return None
    if profile is None:
        print(f"Error: Profile not found: {profile_id}", file=sys.stderr)
        print("Use `tuck profiles list` to see available profiles.", file=sys.stderr)
        return None

    expected_workflow = WORKFLOW_COMPRESSION if args.command == "compress" else WORKFLOW_UPSCALE
    if profile.workflow != expected_workflow:
        print(
            f"Error: Profile '{profile_id}' is for {profile.workflow}, not {args.command}.",
            file=sys.stderr,
        )
        return None

    if args.command == "compress" and args.size:
        if args.size <= 0:
            print("Error: --size must be greater than zero.", file=sys.stderr)
            return None
        profile = _profile_with_target_size(profile, args.size)

    return profile


def _process_single_file(args, profile, output_dir: str) -> int:
    from .planner import plan as create_plan

    try:
        p = create_plan(
            args.files[0],
            profile,
            output=args.output,
            output_dir=output_dir,
        )
        if args.review:
            _print_plan(p)
            resp = input("Proceed with encoding? [y/N] ").strip().lower()
            if resp not in ("y", "yes"):
                print("Aborted.")
                return 0

        return _do_encode(p)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


def _process_file_batch(args, profile, output_dir: str) -> int:
    from .planner import plan as create_plan

    errors = 0
    for f in args.files:
        try:
            p = create_plan(
                f,
                profile,
                output_dir=output_dir,
            )
            if args.review:
                _print_plan(p)
                resp = (
                    input(f"Proceed with encoding {Path(f).name}? [y/N/skip all] ").strip().lower()
                )
                if resp in ("s", "skip all", "skip"):
                    print("Skipping remaining files.")
                    break
                if resp not in ("y", "yes"):
                    print("Skipping.")
                    continue

            code = _do_encode(p)
            if code != 0:
                errors += 1
        except Exception as e:
            print(f"Error planning {f}: {e}", file=sys.stderr)
            errors += 1

    return 0 if errors == 0 else 3


def _cmd_process(args) -> int:
    from .settings import get_settings_manager

    mgr = get_settings_manager()
    mgr.load()
    profile = _resolve_profile(args, mgr.get_profiles())
    if profile is None:
        return 1

    from .engine import is_ffmpeg_available
    from .probe import is_ffprobe_available

    if not is_ffprobe_available() or not is_ffmpeg_available():
        print("Error: FFmpeg/ffprobe not found. Install FFmpeg.", file=sys.stderr)
        return 2

    output_dir = str(mgr.get_setting("output_dir", "") or "")

    if len(args.files) == 1 and args.output:
        return _process_single_file(args, profile, output_dir)

    return _process_file_batch(args, profile, output_dir)


def _do_encode(plan) -> int:
    from .engine import FFmpegEngine
    from .models import EncodeProgress

    engine = FFmpegEngine()
    target = (
        f"{plan.target_size / (1024 * 1024):.1f} MB"
        if plan.workflow == "compression"
        else f"{plan.target_width}x{plan.target_height}"
    )
    console.print(
        Panel(
            f"[bold]{Path(plan.source).name}[/bold]\n"
            f"[muted]{plan.workflow.title()} | {target} | {plan.target_fps:.1f} fps[/muted]\n"
            f"[muted]Output[/muted] {Path(plan.output).name}",
            border_style="brand",
            padding=(0, 1),
        )
    )
    progress = Progress(
        SpinnerColumn(style="accent"),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(complete_style="accent", finished_style="success"),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
        transient=console.is_interactive,
    )
    try:
        with progress:
            task = progress.add_task("Processing", total=100)
            result = engine.encode(
                plan,
                on_progress=lambda value: progress.update(
                    task,
                    completed=value.percent if isinstance(value, EncodeProgress) else value,
                ),
            )
        size_mb = result.stat().st_size / (1024 * 1024)
        console.print(f"[success]Complete[/success] [muted]{result} | {size_mb:.1f} MB[/muted]")
        return 0
    except Exception as e:
        error_console.print(f"[red]Error:[/red] {e}")
        return 3


def _resolve_console_profile(mgr, profile_id: str | None):
    from .models import find_profile_by_id

    resolved_id = profile_id or str(mgr.get_setting("default_profile_id", "") or "discord-10mb")
    profile = find_profile_by_id(mgr.get_profiles(), resolved_id)
    if profile is None:
        print(f"Error: Profile not found: {resolved_id}")
        print("Use `tuck profiles list` to see available profiles.")
    return profile


def _encode_queue(
    valid: list[str], profile, output_dir: str
) -> tuple[list[tuple[str, str, float]], int]:
    from .planner import plan as create_plan

    total = len(valid)
    errors = 0
    results: list[tuple[str, str, float]] = []  # name, output, size_mb

    for idx, path in enumerate(valid, start=1):
        name = Path(path).name
        console.print(f"[accent]{idx:02d}[/accent] [muted]of {total:02d}[/muted]  {name}")
        try:
            enc_plan = create_plan(path, profile, output_dir=output_dir)
            code = _do_encode(enc_plan)
            if code != 0:
                errors += 1
            else:
                out = Path(enc_plan.output)
                size_mb = out.stat().st_size / (1024 * 1024) if out.is_file() else 0.0
                results.append((name, str(out), size_mb))
        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
            errors += 1
        console.print()

    return results, errors


def _print_queue_summary(results: list[tuple[str, str, float]], errors: int, total: int) -> None:
    summary = _table("QUEUE COMPLETE")
    summary.add_column("Status")
    summary.add_column("Source")
    summary.add_column("Output")
    summary.add_column("Size", justify="right")
    for name, out, size_mb in results:
        summary.add_row("[success]Done[/success]", name, Path(out).name, f"{size_mb:.1f} MB")
    if errors:
        summary.add_row("[error]Failed[/error]", f"{errors} file(s)", "See errors above", "")
    console.print(summary)
    console.print(
        f"[success]{total - errors} complete[/success] [muted]|[/muted] "
        f"[error]{errors} failed[/error]"
    )


def run_console_encode(files: list[str], profile_id: str | None = None) -> int:

    from .engine import is_ffmpeg_available
    from .probe import is_ffprobe_available
    from .settings import get_settings_manager

    if not is_ffprobe_available() or not is_ffmpeg_available():
        print("Error: FFmpeg/ffprobe not found. Install FFmpeg and ensure it is on PATH.")
        return 2

    mgr = get_settings_manager()
    mgr.load()
    profile = _resolve_console_profile(mgr, profile_id)
    if profile is None:
        return 1

    valid = [f for f in files if Path(f).is_file()]
    if not valid:
        print("Error: no valid input files.")
        return 1

    total = len(valid)
    _print_queue_header(profile, total)
    console.print()

    output_dir = str(mgr.get_setting("output_dir", "") or "")
    results, errors = _encode_queue(valid, profile, output_dir)
    _print_queue_summary(results, errors, total)

    return 0 if errors == 0 else 3


def _print_plan(p) -> None:
    workflow = getattr(p, "workflow", "compression")
    table = _table("PROCESSING PLAN", show_header=False)
    table.add_column(style="cyan")
    table.add_column()
    table.add_row("Source", str(p.source))
    table.add_row("Output", str(p.output))
    table.add_row("Profile", p.profile_id)
    table.add_row("Workflow", workflow)
    table.add_row("Rate control", getattr(p, "rate_control_method", "crf"))
    table.add_row("Resolution", f"{p.target_width}x{p.target_height}")
    table.add_row("Frame rate", f"{p.target_fps:.2f} fps")
    table.add_row("Video bitrate", f"{p.video_bitrate // 1000} kbps")
    table.add_row("Audio bitrate", f"{p.audio_bitrate // 1000} kbps")
    table.add_row("Two-pass", "yes" if p.two_pass else "no")
    table.add_row("Estimated size", f"{p.estimated_size / (1024 * 1024):.1f} MB")
    if workflow == "compression":
        table.add_row("Size limit", f"{p.target_size / (1024 * 1024):.1f} MB")
    console.print(table)


def _profile_with_target_size(profile, target_size_mb):

    import copy

    p = copy.copy(profile)
    p.target_size_bytes = int(target_size_mb * 1024 * 1024)
    return p


def _profile_with_resolution(profile, resolution):

    import copy
    import re

    match = re.fullmatch(r"(\d+)x(\d+)", resolution.lower())
    if not match:
        raise ValueError("--resolution must use WIDTHxHEIGHT, for example 2560x1440")

    width, height = map(int, match.groups())
    if width < 2 or height < 2:
        raise ValueError("--resolution dimensions must be at least 2")

    p = copy.copy(profile)
    p.resolution_mode = "custom"
    p.custom_width = width
    p.custom_height = height
    return p


def _cmd_profiles(args) -> int:
    from .settings import get_settings_manager

    mgr = get_settings_manager()
    mgr.load()

    if args.profiles_cmd == "list":
        table = _table("PROFILES")
        table.add_column("ID", style="cyan")
        table.add_column("Name")
        table.add_column("Workflow")
        table.add_column("Target", justify="right")
        for p in mgr.get_profiles():
            target = (
                f"{p.custom_width}x{p.custom_height}"
                if p.workflow == "upscale"
                else f"{p.target_size_bytes / (1024 * 1024):.0f} MB"
            )
            table.add_row(p.profile_id, p.name, p.workflow.title(), target)
        console.print(table)
        return 0
    elif args.profiles_cmd == "export":
        from .models import export_profiles_json

        try:
            export_profiles_json(mgr.get_profiles(), Path(args.output))
            print(f"Profiles exported to: {args.output}")
            return 0
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1
    elif args.profiles_cmd == "import":
        from .models import import_profiles_json, merge_imported_profiles

        try:
            imported = import_profiles_json(Path(args.file))
            merged = merge_imported_profiles(mgr.get_profiles(), imported)
            mgr.set_profiles(merged)
            mgr.save()
            print(f"Imported {len(imported)} profiles from: {args.file}")
            return 0
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1
    else:
        return _cmd_profiles(argparse.Namespace(profiles_cmd="list"))


def _cmd_settings(args) -> int:
    from .settings import get_settings_manager

    mgr = get_settings_manager()
    mgr.load()

    if args.settings_cmd == "reset":
        mgr.reset()
        mgr.save()
        console.print("[green]Settings reset to defaults.[/green]")
        return 0
    else:
        s = mgr.load()
        table = _table("SETTINGS", show_header=False)
        table.add_column(style="cyan")
        table.add_column()
        table.add_row("Default profile", s.default_profile_id)
        table.add_row("Output directory", s.output_dir or "Source directory")
        table.add_row("Check for updates", "yes" if s.check_updates else "no")
        table.add_row("FFmpeg", s.ffmpeg_path or "Auto-detect")
        table.add_row("FFprobe", s.ffprobe_path or "Auto-detect")
        table.add_row("Config directory", str(mgr.config_dir))
        table.add_row("Data directory", str(mgr.data_dir))
        table.add_row("Cache directory", str(mgr.cache_dir))
        console.print(table)
        return 0


def _cmd_sendto(args) -> int:
    from .sendto import (
        install_sendto,
        remove_all_profile_shortcuts,
        repair_sendto,
        uninstall_sendto,
    )

    def _install() -> str:
        path = install_sendto()
        return f"Send To shortcut installed: {path}"

    def _uninstall() -> str:
        uninstall_sendto()
        return "Send To shortcut removed."

    def _uninstall_all() -> str:
        uninstall_sendto()
        count = remove_all_profile_shortcuts()
        return f"All Send To shortcuts removed ({count} profile shortcuts)."

    def _repair() -> str:
        if repair_sendto():
            return "Send To shortcut repaired."
        return "Send To shortcut does not need repair."

    actions: dict[str, Callable[[], str]] = {
        "install": _install,
        "uninstall": _uninstall,
        "uninstall-all": _uninstall_all,
        "repair": _repair,
    }
    action = actions.get(args.sendto_cmd)
    if action is None:
        print("Usage: tuck sendto {install|uninstall|uninstall-all|repair}")
        return 0

    try:
        print(action())
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
