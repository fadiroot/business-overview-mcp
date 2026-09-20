from fastapi import FastAPI
from .routers import projects
app = FastAPI()
app.include_router(projects.router, prefix="/api/v1")

@app.get("/health")
def health():
    return {"ok": True}
