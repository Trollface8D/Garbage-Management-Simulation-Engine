from .compat import router as compat_router
from .extract import router as extract_router
from .health import router as health_router
from .jobs_artifacts import router as jobs_artifacts_router
from .jobs_create import router as jobs_create_router
from .jobs_query import router as jobs_query_router
from .jobs_stream import router as jobs_stream_router
from .map_extract import router as map_extract_router

__all__ = [
	"compat_router",
	"extract_router",
	"health_router",
	"jobs_artifacts_router",
	"jobs_create_router",
	"jobs_query_router",
	"jobs_stream_router",
	"map_extract_router",
]
