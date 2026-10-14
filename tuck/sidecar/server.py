from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import TextIO

from ..request_work import RequestWork
from .handlers import dispatch
from .lifecycle import BackendLifecycle
from .protocol import (
    Event,
    ProtocolError,
    Response,
    encode_event,
    encode_response,
    frame_fits,
    parse_request,
)

logger = logging.getLogger(__name__)

# probes, pictures and waveforms can take many seconds each, and importing a folder asks for
# many at once; they get their own workers so settings, queue and status requests never wait
# behind them and time out in the shell while the work carries on here
MEDIA_METHODS = frozenset(
    {"probe_file", "probe_audio_file", "get_waveform", "get_thumbnail", "export_frame"}
)
_CONTROL_WORKERS = 4
_MEDIA_WORKERS = 4


def run_server(
    stdin: TextIO,
    stdout: TextIO,
    stderr: TextIO,
    lifecycle: BackendLifecycle | None = None,
) -> int:
    lifecycle = lifecycle or BackendLifecycle()
    write_lock = threading.Lock()
    control = ThreadPoolExecutor(max_workers=_CONTROL_WORKERS, thread_name_prefix="tuck-sidecar")
    media = ThreadPoolExecutor(max_workers=_MEDIA_WORKERS, thread_name_prefix="tuck-media")
    seen_ids: set[str] = set()
    request_work: set[RequestWork] = set()
    work_lock = threading.Lock()

    def write_response(response: Response) -> None:
        frame = encode_response(response)
        if not frame_fits(frame):
            # the shell would drop the whole backend for one oversized line, so only this
            # request fails
            logger.error("Response frame of %d characters is over the protocol limit", len(frame))
            frame = encode_response(
                Response.failure(
                    response.request_id,
                    code="RESPONSE_TOO_LARGE",
                    message="The backend reply was too large to send.",
                )
            )
            if not frame_fits(frame):
                # only a request id near the limit gets here; the shell times the request out
                logger.error("Request id is too long to answer within the protocol limit")
                return
        with write_lock:
            stdout.write(frame + "\n")
            stdout.flush()

    def write_event(event: Event) -> None:
        with write_lock:
            stdout.write(encode_event(event) + "\n")
            stdout.flush()

    def complete(future: Future[Response], request_id: str, work: RequestWork) -> None:
        try:
            write_response(future.result())
        except Exception:
            logger.exception("Sidecar request worker failed")
            write_response(
                Response.failure(
                    request_id,
                    code="INTERNAL_ERROR",
                    message="The backend could not complete the request.",
                )
            )
        finally:
            with work_lock:
                request_work.discard(work)

    def cancel_requests() -> None:
        with work_lock:
            for work in request_work:
                work.set()

    def shutdown_workers(*, wait: bool) -> None:
        for pool in (control, media):
            pool.shutdown(wait=wait, cancel_futures=not wait)

    try:
        api = lifecycle.start()
        write_event(lifecycle.ready_event())
        for line in stdin:
            try:
                request = parse_request(line)
            except ProtocolError as exc:
                write_response(
                    Response.failure(
                        exc.request_id or "invalid-request", code=exc.code, message=str(exc)
                    )
                )
                continue
            if request.request_id in seen_ids:
                write_response(
                    Response.failure(
                        request.request_id,
                        code="INVALID_REQUEST",
                        message="Request id must be unique.",
                    )
                )
                continue
            seen_ids.add(request.request_id)
            if request.method == "shutdown":
                if request.params:
                    write_response(
                        Response.failure(
                            request.request_id,
                            code="INVALID_REQUEST",
                            message="Request parameters are invalid.",
                        )
                    )
                    continue
                cancel_requests()
                shutdown_workers(wait=True)
                lifecycle.shutdown()
                write_response(Response.success(request.request_id, {"status": "stopped"}))
                return 0
            work = RequestWork()
            with work_lock:
                request_work.add(work)
            media_request = request.method in MEDIA_METHODS or (
                request.method == "get_media_url" and "track" in request.params
            )
            executor = media if media_request else control
            future = executor.submit(dispatch, api, request, work)
            future.add_done_callback(
                lambda completed, request_id=request.request_id, work=work: complete(
                    completed, request_id, work
                )
            )
        cancel_requests()
        shutdown_workers(wait=True)
        lifecycle.shutdown()
        return 0
    except Exception:
        logger.exception("Sidecar fatal failure")
        try:
            write_event(
                Event(
                    event="backend_fatal",
                    payload={
                        "code": "INTERNAL_ERROR",
                        "message": "The backend could not start.",
                        "details": {},
                    },
                )
            )
        except Exception:
            logger.exception("Could not write sidecar fatal event")
        lifecycle.shutdown()
        return 1
    finally:
        cancel_requests()
        shutdown_workers(wait=False)
