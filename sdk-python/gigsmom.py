"""
GIGS.MOM Python SDK — Post tasks for humans from AI agents.

Usage:
    from gigsmom import GigsMom

    gigs = GigsMom(
        url="https://your-deployment.convex.site",
        private_key="0x...",  # Agent's wallet with USDC on Base
    )

    # Post a task
    result = gigs.post_task(
        title="Count cars at this intersection",
        task_type="gather-info",
        location_addr="Rue de la Loi 200, Brussels",
        location_lat=50.8467,
        location_lng=4.3660,
        action="Stand at the intersection and count all cars for 1 hour",
        proof_type="text",
        suggested_fee=15.0,
        poster_id="your_convex_user_id",
    )

    # List open tasks
    tasks = gigs.list_tasks()

    # Cancel a task
    gigs.cancel_task(task_id="...", poster_id="...")
"""

import json
import os
import secrets
import time
import requests

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    HAS_ETH = True
except ImportError:
    HAS_ETH = False


class GigsMom:
    """Client for the GIGS.MOM agentic commerce protocol."""

    USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    CHAIN_ID = 8453  # Base Mainnet

    def __init__(self, url=None, private_key=None):
        self.url = (url or os.environ.get("GIGSMOM_URL", "")).rstrip("/")
        self.private_key = private_key or os.environ.get("GIGSMOM_PRIVATE_KEY")
        if not self.url:
            raise ValueError("GIGSMOM_URL required")

    def _api_call(self, path, body):
        """POST to a GIGS.MOM HTTP endpoint, handling x402 payment if needed."""
        url = f"{self.url}{path}"

        # First attempt
        res = requests.post(url, json=body)

        if res.status_code != 402:
            return {"status": res.status_code, "data": res.json()}

        # 402 — payment required
        if not self.private_key:
            return {"status": 402, "data": {"error": "Payment required but no private key configured"}}
        if not HAS_ETH:
            return {"status": 402, "data": {"error": "Install eth-account: pip install eth-account"}}

        payment_info = res.json()
        requirements = (payment_info.get("accepts") or [{}])[0]
        if not requirements:
            return {"status": 402, "data": {"error": "No payment requirements"}}

        payment_header = self._sign_x402(requirements)

        # Retry with payment
        res2 = requests.post(url, json=body, headers={"X-Payment": payment_header})
        return {"status": res2.status_code, "data": res2.json()}

    def _sign_x402(self, req):
        """Sign an x402 payment using EIP-3009 TransferWithAuthorization."""
        account = Account.from_key(self.private_key)
        amount = int(req["maxAmountRequired"])
        pay_to = req["payTo"]
        nonce = "0x" + secrets.token_hex(32)
        valid_after = 0
        valid_before = int(time.time()) + (req.get("maxTimeoutSeconds") or 300)

        domain = {
            "name": req.get("extra", {}).get("name", "USD Coin"),
            "version": req.get("extra", {}).get("version", "2"),
            "chainId": self.CHAIN_ID,
            "verifyingContract": self.USDC_ADDRESS,
        }

        message = {
            "from": account.address,
            "to": pay_to,
            "value": amount,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": int(nonce, 16),
        }

        types = {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        }

        signable = encode_typed_data(
            domain_data=domain,
            message_types={"TransferWithAuthorization": types["TransferWithAuthorization"]},
            message_data=message,
        )
        signed = account.sign_message(signable)

        payload = {
            "x402Version": 1,
            "scheme": "exact",
            "network": "base",
            "payload": {
                "signature": signed.signature.hex(),
                "authorization": {
                    "from": account.address,
                    "to": pay_to,
                    "value": str(amount),
                    "validAfter": str(valid_after),
                    "validBefore": str(valid_before),
                    "nonce": nonce,
                },
            },
        }

        import base64
        return base64.b64encode(json.dumps(payload).encode()).decode()

    # ── High-level API ──

    def post_task(
        self,
        title,
        task_type="gather-info",
        category=None,
        details=None,
        steps=None,
        location_addr=None,
        location_lat=None,
        location_lng=None,
        action=None,
        proof_type="photo",
        target_person=None,
        pickup_addr=None,
        pickup_lat=None,
        pickup_lng=None,
        dropoff_addr=None,
        dropoff_lat=None,
        dropoff_lng=None,
        item_cost=None,
        suggested_fee=5.0,
        max_runners=1,
        privacy_zone=100,
        poster_id=None,
    ):
        """Post a task on GIGS.MOM. Returns task ID on success.

        Tasks are workflow-based: pass a list of steps, each with an action,
        optional location, and proof type. The runner completes them in order.

        Args:
            steps: List of workflow steps, each a dict with:
                - action (str): What to do at this step
                - location_addr (str, optional): Address for this step
                - location_lat (float, optional): Latitude
                - location_lng (float, optional): Longitude
                - proof_type (str, optional): photo, video, text, gps, none
                - requirements (str, optional): e.g. "van", "camera", "ID"
        """
        body = {
            "title": title,
            "taskType": task_type,
            "category": category or task_type,
            "details": details or (
                " → ".join(s.get("action", "") for s in steps) if steps
                else action or "No instructions."
            ),
            "suggestedFee": suggested_fee,
            "maxRunners": max_runners,
            "privacyZone": privacy_zone,
            "posterId": poster_id,
        }

        # Workflow steps (preferred)
        if steps:
            body["steps"] = [
                {
                    "order": i + 1,
                    "action": s.get("action", ""),
                    "status": "pending",
                    **({k: s[k] for k in (
                        "locationAddr", "locationLat", "locationLng",
                        "proofType", "requirements",
                    ) if k in s}),
                    # Also accept snake_case keys
                    **({
                        "locationAddr": s["location_addr"],
                    } if "location_addr" in s else {}),
                    **({
                        "locationLat": s["location_lat"],
                    } if "location_lat" in s else {}),
                    **({
                        "locationLng": s["location_lng"],
                    } if "location_lng" in s else {}),
                    **({
                        "proofType": s["proof_type"],
                    } if "proof_type" in s else {}),
                }
                for i, s in enumerate(steps)
            ]
            # Derive pickup/dropoff from first/last step with location
            locs = [s for s in body["steps"] if s.get("locationAddr")]
            if len(locs) >= 2 and task_type == "delivery":
                body["pickupAddr"] = locs[0]["locationAddr"]
                body["pickupLat"] = locs[0].get("locationLat", 50.85)
                body["pickupLng"] = locs[0].get("locationLng", 4.35)
                body["dropoffAddr"] = locs[-1]["locationAddr"]
                body["dropoffLat"] = locs[-1].get("locationLat", 50.85)
                body["dropoffLng"] = locs[-1].get("locationLng", 4.35)
                body["itemCost"] = item_cost or 0
            elif locs:
                body["locationAddr"] = locs[0]["locationAddr"]
                body["locationLat"] = locs[0].get("locationLat", 50.85)
                body["locationLng"] = locs[0].get("locationLng", 4.35)
                body["action"] = " → ".join(s.get("action", "") for s in body["steps"])
                body["proofType"] = next(
                    (s.get("proofType") for s in body["steps"] if s.get("proofType") and s["proofType"] != "none"),
                    "photo"
                )
        elif task_type == "delivery":
            body.update({
                "pickupAddr": pickup_addr,
                "pickupLat": pickup_lat,
                "pickupLng": pickup_lng,
                "dropoffAddr": dropoff_addr,
                "dropoffLat": dropoff_lat,
                "dropoffLng": dropoff_lng,
                "itemCost": item_cost or 0,
            })
        else:
            body.update({
                "locationAddr": location_addr,
                "locationLat": location_lat,
                "locationLng": location_lng,
                "action": action,
                "proofType": proof_type,
                "targetPerson": target_person,
            })

        # Remove None values
        body = {k: v for k, v in body.items() if v is not None}

        return self._api_call("/task", body)

    def accept_bid(self, task_id, bid_id, poster_id):
        """Accept a runner's bid."""
        return self._api_call("/accept-bid", {
            "taskId": task_id,
            "bidId": bid_id,
            "posterId": poster_id,
        })

    def confirm_delivery(self, task_id, poster_id, runner_id=None, rating_score=None, rating_comment=None):
        """Confirm task completion and release payment."""
        body = {"taskId": task_id, "posterId": poster_id}
        if runner_id:
            body["runnerId"] = runner_id
        if rating_score:
            body["ratingScore"] = rating_score
        if rating_comment:
            body["ratingComment"] = rating_comment
        return self._api_call("/confirm-delivery", body)

    def cancel_task(self, task_id, poster_id):
        """Cancel an open task and get refund."""
        return self._api_call("/cancel-task", {
            "taskId": task_id,
            "posterId": poster_id,
        })

    def list_tasks(self):
        """List open tasks (via Convex query)."""
        query_url = self.url.replace(".site", ".cloud") + "/api/query"
        res = requests.post(query_url, json={"path": "tasks:listOpen", "args": {}})
        data = res.json()
        return data.get("value", [])

    def get_task(self, task_id):
        """Get task details."""
        query_url = self.url.replace(".site", ".cloud") + "/api/query"
        res = requests.post(query_url, json={"path": "tasks:getTask", "args": {"taskId": task_id}})
        return res.json().get("value")

    def health(self):
        """Check server health."""
        res = requests.get(f"{self.url}/health")
        return res.json()
