from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import TextIO

from .handlers import dispatch
from .lifecycle import BackendLifecycle
from .protocol import (
    Event,
    ProtocolError,
    Response,
    encode_event,
    encode_response,
    parse_request,
)

logger = logging.getLogger(__name__)


def run_server(
    stdin: TextIO,
    stdout: TextIO,
    stderr: TextIO,
    lifecycle: BackendLifecycle | None = None,
) -> int:
    lifecycle = lifecycle or BackendLifecycle()
    write_lock = threading.Lock()
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tuck-sidecar")
    seen_ids: set[str] = set()

    def write_response(response: Response) -> None:
        with write_lock:
            stdout.write(encode_response(response) + "\n")
            stdout.flush()

    def write_event(event: Event) -> None:
        with write_lock:
            stdout.write(encode_event(event) + "\n")
            stdout.flush()

    def complete(future: Future[Response], request_id: str) -> None:
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
                executor.shutdown(wait=True)
                lifecycle.shutdown()
                write_response(Response.success(request.request_id, {"status": "stopped"}))
                return 0
            future = executor.submit(dispatch, api, request)
            future.add_done_callback(
                lambda completed, request_id=request.request_id: complete(completed, request_id)
            )
        executor.shutdown(wait=True)
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
                    },
                )
            )
        except Exception:
            logger.exception("Could not write sidecar fatal event")
        lifecycle.shutdown()
        return 1
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
