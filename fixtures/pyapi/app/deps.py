from fastapi import Depends, HTTPException
def get_current_user():
    return {"role": "member"}
def require_role(*roles):
    def dep(user=Depends(get_current_user)):
        if user["role"] not in roles:
            raise HTTPException(403)
        return user
    return dep
