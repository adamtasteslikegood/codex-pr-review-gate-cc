"""Python client regressions; stdlib only, no sockets or real credentials."""

import importlib.util
import io
import threading
import unittest
import urllib.request
import urllib.response
from email.message import Message
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("relay_work", Path(__file__).parents[1] / "client" / "relay_work.py")
relay_work = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay_work)


class RelayWorkTest(unittest.TestCase):
    def client(self, headers=None):
        return relay_work.RelayWork("https://relay.example", headers or {}, "owner/repo", "test", "test-holder", "s" * 32)

    def test_https_opener_uses_configured_context_and_returns_json(self):
        client = self.client()

        def transport(handler, request):
            self.assertIs(handler._context, client.context)
            self.assertEqual(request.get_method(), "POST")
            response = urllib.response.addinfourl(io.BytesIO(b'{"ok": true}'), Message(), request.full_url, 200)
            response.msg = "OK"
            return response

        with patch.object(urllib.request.HTTPSHandler, "https_open", transport):
            self.assertEqual(client.get("gh#12"), {"ok": True})

    def test_redirects_do_not_forward_credentials(self):
        for destination in ("https://other.example/login", "http://other.example/login"):
            for credentials in ({"CF-Access-Client-Id": "fake-id", "CF-Access-Client-Secret": "fake-secret"},
                                {"cf-access-token": "fake-person-token"}):
                with self.subTest(destination=destination, credentials=list(credentials)):
                    calls = []

                    def transport(handler, request):
                        calls.append(request)
                        headers = Message()
                        headers["Location"] = destination
                        status = 302 if len(calls) == 1 else 200
                        response = urllib.response.addinfourl(io.BytesIO(b'{}'), headers, request.full_url, status)
                        response.msg = "Found" if status == 302 else "OK"
                        return response

                    # Replace only the network transport: real urllib redirect/error handling still runs.
                    with patch.object(urllib.request.HTTPSHandler, "https_open", transport), \
                         patch.object(urllib.request.HTTPHandler, "http_open", transport):
                        with self.assertRaises(relay_work.RelayRefused) as refused:
                            self.client(credentials).get("gh#12")
                    self.assertEqual(refused.exception.status, 302)
                    self.assertEqual(len(calls), 1)

    def test_old_keepalive_does_not_renew_replacement_claim(self):
        client = self.client()
        client.tokens["gh#12"] = 1
        beat_seen = threading.Event()
        sent_tokens = []

        def send(body):
            if body["op"] == "claim":
                return {"token": 2}
            sent_tokens.append(body["token"])
            beat_seen.set()
            raise relay_work.RelayRefused(409, {"error": "lost"})

        with patch.object(client, "_send", send):
            with client.keepalive("gh#12", every=5) as lost:
                client.claim("gh#12")
                self.assertTrue(beat_seen.wait(8), "keepalive did not send a beat")
                self.assertTrue(lost.wait(1), "refused beat did not signal loss")
        self.assertEqual(sent_tokens, [1])
        self.assertEqual(client.tokens["gh#12"], 2)


if __name__ == "__main__":
    unittest.main()
