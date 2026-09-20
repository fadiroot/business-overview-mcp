from fastapi import APIRouter, Depends
from ..deps import get_current_user, require_role
router = APIRouter(prefix="/projects", tags=["projects"])

@router.get("/")
def list_projects(user=Depends(get_current_user)):
    return []

@router.post("/", dependencies=[Depends(require_role("owner", "admin"))])
def create_project(payload: dict):
    return payload

@router.delete("/{project_id}")
def delete_project(project_id: int, user=Depends(require_role("admin"))):
    return {}
