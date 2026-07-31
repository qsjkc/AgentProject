from app.models.database import Reminder


def clear_email_claim(reminder: Reminder) -> None:
    reminder.email_claimed_at = None
    reminder.email_claim_token = None
    reminder.email_next_attempt_at = None


def reset_email_delivery(reminder: Reminder, *, force_resend: bool = False) -> None:
    if reminder.email_sent_at is not None and not force_resend:
        return
    if force_resend:
        reminder.email_sent_at = None
    clear_email_claim(reminder)
    reminder.email_attempt_count = 0
    reminder.email_last_error = None
    if reminder.status != "pending":
        reminder.email_status = "canceled"
    elif reminder.email_enabled:
        reminder.email_status = "pending"
    else:
        reminder.email_status = "disabled"


def stop_email_delivery(reminder: Reminder) -> None:
    if reminder.email_sent_at is not None:
        return
    clear_email_claim(reminder)
    reminder.email_status = "canceled"
