"""Verify a deployed release through HTTPS with two disposable admin-created users.

This is a production API smoke check, not email registration acceptance. Only the
users created by this run are deleted. Credentials and tokens are never reported.
"""
import argparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import json
from pathlib import Path
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from dotenv import dotenv_values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--credentials-env', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    base = args.base_url.rstrip('/')
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path:
        raise ValueError('An HTTPS origin without credentials or a path is required')
    credentials = dotenv_values(args.credentials_env)
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'baseUrl': base,
              'version': args.expected_version, 'status': 'running', 'checks': [],
              'scope': 'Public API with disposable admin-provisioned accounts; not SMTP or Web registration proof',
              'cleanup': []}
    owned = []
    admin = None

    def request(method, path, payload=None, token=None, expected=200, form=False):
        headers = {}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        data = None
        if payload is not None:
            data = (urllib.parse.urlencode(payload) if form else json.dumps(payload)).encode()
            headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        try:
            # Non-streaming model replies may use the provider's 60-second
            # read timeout before the API commits and returns the response.
            timeout = 90 if path == '/api/v1/chat/message' else 30
            response = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            body = json.loads(raw) if raw else None
            if response.status != expected:
                # Do not echo response bodies: authentication replies contain secrets.
                raise AssertionError(f'{method} {path}: expected {expected}, received {response.status}')
            return body, response.headers

    def api(method, path, payload=None, token=None, expected=200, form=False):
        return request(method, '/api/v1' + path, payload, token, expected, form)[0]

    def passed(name, **details):
        report['checks'].append({'name': name, 'status': 'passed', **details})

    try:
        health, _ = request('GET', '/health/ready')
        assert health['status'] == 'ready'
        version = api('GET', '/public/version/win-x64')
        assert version['version'] == args.expected_version and version['available']
        passed('public-readiness-and-version')
        admin = api('POST', '/auth/login', {'username': credentials['INITIAL_ADMIN_USERNAME'],
                    'password': credentials['INITIAL_ADMIN_PASSWORD']}, form=True)['access_token']
        assert api('GET', '/auth/me', token=admin)['is_superuser']
        suffix = secrets.token_hex(6)
        accounts = []
        for tag in ('a', 'b'):
            username = f'releasecheck-{suffix}-{tag}'
            password = secrets.token_urlsafe(24)
            email = username + '@example.com'
            existing = api('GET', '/admin/users?search=' + urllib.parse.quote(username), token=admin)
            assert not any(item['username'] == username or item['email'] == email for item in existing['items'])
            intent = {'id': None, 'username': username, 'email': email, 'password': password}
            owned.append(intent)
            user = api('POST', '/admin/users', {'username': username, 'email': email,
                       'password': password}, admin, expected=201)
            intent['id'] = user['id']
            assert user['preferences']['pet_type'] == 'pig'
            token = api('POST', '/auth/login', {'username': username, 'password': password}, form=True)['access_token']
            accounts.append((user, token, username, password))
        passed('two-new-admin-provisioned-users-login-default-pig')
        token = accounts[0][1]
        relationships = {}
        for pet in ('pig', 'cat', 'dog'):
            prefs = api('PUT', '/users/me/preferences', {'pet_type': pet}, token)
            assert prefs['pet_type'] == pet
            before = api('GET', f'/pets/{pet}/relationship', token=token)
            assert before['intimacy_xp'] == 0 and before['level'] == 1
            assert before['outfit']['unlocked_outfit_ids'] == [f'{pet}_basic_scarf']
            for action in ('pat', 'feed', 'clean'):
                payload = {'action': action, 'idempotency_key': f'{suffix}:{pet}:{action}'}
                reward = api('POST', f'/pets/{pet}/relationship/rewards', payload, token)
                assert reward['awarded_xp'] > 0 and reward['relationship']['pet_type'] == pet
                duplicate = api('POST', f'/pets/{pet}/relationship/rewards', payload, token)
                assert duplicate['awarded_xp'] == 0 and duplicate['reason'] == 'duplicate'
            equipped = api('PUT', f'/pets/{pet}/relationship/outfit',
                           {'slot': 'neck', 'item_id': f'{pet}_basic_scarf'}, token)
            assert equipped['outfit']['equipped_outfits']['neck'] == f'{pet}_basic_scarf'
            foreign = 'cat' if pet != 'cat' else 'dog'
            api('PUT', f'/pets/{pet}/relationship/outfit',
                {'slot': 'neck', 'item_id': f'{foreign}_basic_scarf'}, token, expected=422)
            api('PUT', f'/pets/{pet}/relationship/outfit',
                {'slot': 'head', 'item_id': f'{pet}_star_hat'}, token, expected=409)
            daily = api('GET', f'/pets/{pet}/daily-summary', token=token)
            weekly = api('GET', f'/pets/{pet}/weekly-summary', token=token)
            assert daily['pet_type'] == pet and daily['care_count'] == 3
            assert weekly['pet_type'] == pet and not weekly['eligible']
            other = api('GET', f'/pets/{pet}/relationship', token=accounts[1][1])
            assert other['intimacy_xp'] == 0 and other['outfit']['equipped_outfits'] == {}
            relationships[pet] = api('GET', f'/pets/{pet}/relationship', token=token)
            passed(f'{pet}-care-growth-idempotency-outfits-summaries-account-isolation')
        assert len({value['id'] for value in relationships.values()}) == 3
        for pet, saved in relationships.items():
            current = api('GET', f'/pets/{pet}/relationship', token=token)
            assert current['intimacy_xp'] == saved['intimacy_xp']
            assert current['outfit'] == saved['outfit']
        passed('later-pet-actions-do-not-change-earlier-pets')
        _, headers = request('GET', '/health/ready')
        due = parsedate_to_datetime(headers['Date']) + timedelta(seconds=60)
        wait_until = time.monotonic() + 61
        reminders = []
        for pet in ('cat', 'dog'):
            reminder = api('POST', '/reminders', {'pet_type': pet, 'title': f'Release verification {pet}',
                'remind_at': due.isoformat(), 'email_enabled': False}, token)
            reminders.append(reminder)
            api('POST', f'/reminders/{reminder["id"]}/trigger', token=token, expected=409)
            api('POST', f'/reminders/{reminder["id"]}/complete', token=accounts[1][1], expected=404)
        for pet in ('cat', 'dog'):
            before_chat = {kind: api('GET', f'/pets/{kind}/relationship', token=token)['intimacy_xp']
                           for kind in relationships}
            answer = api('POST', '/chat/message', {'pet_type': pet,
                'message': '你好，我刚来到这里，请用一句话和我打个招呼。',
                'stream': False, 'use_rag': False, 'compact_response': True}, token)
            assert answer['done'] and answer['content'].strip()
            session = api('GET', f'/chat/sessions/{answer["session_id"]}', token=token)
            assert session['user_id'] == accounts[0][0]['id']
            assert [message['role'] for message in session['messages']] == ['user', 'assistant']
            assert session['messages'][-1]['content'] == answer['content']
            api('GET', f'/chat/sessions/{answer["session_id"]}', token=accounts[1][1], expected=404)
            for kind in relationships:
                xp = api('GET', f'/pets/{kind}/relationship', token=token)['intimacy_xp']
                assert xp == before_chat[kind] + (2 if kind == pet else 0)
            passed(f'{pet}-live-model-chat-history-growth-and-ownership')
        while time.monotonic() < wait_until:
            time.sleep(0.5)
        for reminder in reminders:
            path = f'/reminders/{reminder["id"]}'
            triggered = api('POST', path + '/trigger', token=token)
            repeated = api('POST', path + '/trigger', token=token)
            assert triggered['triggered_at'] and triggered['triggered_at'] == repeated['triggered_at']
            completed = api('POST', path + '/complete', token=token)
            assert completed['status'] == 'completed' and completed['completed_at']
            passed(f'{reminder["pet_type"]}-natural-deadline-trigger-complete-ownership')
        for pet in relationships:
            relationships[pet] = api('GET', f'/pets/{pet}/relationship', token=token)
        fresh = api('POST', '/auth/login', {'username': accounts[0][2], 'password': accounts[0][3]}, form=True)['access_token']
        for pet in relationships:
            restored = api('GET', f'/pets/{pet}/relationship', token=fresh)
            assert restored['id'] == relationships[pet]['id']
            assert restored['intimacy_xp'] == relationships[pet]['intimacy_xp']
            assert restored['outfit']['equipped_outfits'] == relationships[pet]['outfit']['equipped_outfits']
        passed('relogin-restores-independent-pet-state')
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        for intent in owned:
            user_id = intent['id']
            try:
                if user_id is None:
                    candidates = api('GET', '/admin/users?search=' + urllib.parse.quote(intent['username']), token=admin)['items']
                    matches = [item for item in candidates if item['username'] == intent['username'] and item['email'] == intent['email']]
                    if not matches:
                        report['cleanup'].append({'status': 'not-created'})
                        continue
                    assert len(matches) == 1 and not matches[0]['is_superuser']
                    # A response may be lost after the server commits. Verify
                    # the run's random password before cleaning up that account.
                    check_token = api('POST', '/auth/login', {'username': intent['username'],
                                      'password': intent['password']}, form=True)['access_token']
                    confirmed = api('GET', '/auth/me', token=check_token)
                    user_id = matches[0]['id']
                    assert confirmed['id'] == user_id
                user = api('GET', f'/admin/users/{user_id}', token=admin)
                assert user['username'] == intent['username'] and user['email'] == intent['email'] and not user['is_superuser']
                api('DELETE', f'/admin/users/{user_id}', token=admin)
                api('GET', f'/admin/users/{user_id}', token=admin, expected=404)
                report['cleanup'].append({'userId': user_id, 'status': 'deleted-and-verified'})
            except Exception as error:
                report['status'] = 'failed'
                report['cleanup'].append({'userId': user_id, 'status': 'failed', 'error': str(error)})
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'report': str(args.report)}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
