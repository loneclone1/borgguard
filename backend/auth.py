"""BorgGuard – Authentication

Simple HTTP Basic Auth for the dashboard.
"""

import secrets
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import config

security = HTTPBasic()


def verify_credentials(
    credentials: HTTPBasicCredentials = Depends(security),
) -> str:
    """Verify HTTP Basic Auth credentials.

    Returns the username if valid, raises 401 otherwise.
    """
    correct_username = secrets.compare_digest(
        credentials.username.encode("utf-8"),
        config.DASHBOARD_USER.encode("utf-8"),
    )
    correct_password = secrets.compare_digest(
        credentials.password.encode("utf-8"),
        config.DASHBOARD_PASSWORD.encode("utf-8"),
    )

    if not (correct_username and correct_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Ungültige Anmeldedaten",
            headers={"WWW-Authenticate": "Basic"},
        )

    return credentials.username
