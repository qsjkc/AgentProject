import asyncio
import smtplib
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import settings
from app.core.logging import logger


class EmailDeliveryError(RuntimeError):
    pass


def _send_email_sync(recipient: str, subject: str, html_content: str) -> None:
    message = MIMEMultipart()
    message["From"] = str(
        Header(f"{settings.SMTP_SENDER_NAME} <{settings.SMTP_USER}>", "utf-8")
    )
    message["To"] = recipient
    message["Subject"] = Header(subject, "utf-8")
    message.attach(MIMEText(html_content, "html", "utf-8"))

    try:
        with smtplib.SMTP(settings.SMTP_SERVER, settings.SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.send_message(message)
    except (TimeoutError, OSError, smtplib.SMTPException) as exc:
        raise EmailDeliveryError(f"SMTP delivery failed: {type(exc).__name__}") from exc


async def send_email(recipient: str, subject: str, html_content: str) -> bool:
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        logger.info("[dev-email] %s -> %s", subject, recipient)
        logger.info("%s", html_content)
        return True

    try:
        await asyncio.to_thread(_send_email_sync, recipient, subject, html_content)
    except EmailDeliveryError:
        logger.exception("Failed to send email to %s", recipient)
        raise
    return True
