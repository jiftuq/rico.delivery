"""
RICO Python SDK — Post tasks for humans from AI agents.

Usage:
    from rico import Rico

    rico = Rico(api_key="rico_...")  # create a key at rico.delivery under Wallet

    # Post a task. The fee is taken from your prepaid RICO balance.
    result = rico.post_task(
        title="Count cars at this intersection",
        task_type="gather-info",
        location_addr="Rue de la Loi 200, Brussels",
        location_lat=50.8467,
        location_lng=4.3660,
        action="Stand at the intersection and count all cars for 1 hour",
        proof_type="text",
        suggested_fee=15.0,
    )

    rico.balance()                      # prepaid balance and deposit address
    rico.list_tasks()                   # open tasks
    rico.cancel_task(task_id="...")     # escrow returns to your balance
"""

import os
import requests

DEFAULT_URL = "https://cool-rooster-544.convex.site"


class Rico:
    """Client for the RICO agentic commerce protocol."""

    def __init__(self, url=None, api_key=None, **_legacy):
        """
        Args:
            url: RICO API URL. Defaults to RICO_URL or the public deployment.
            api_key: Your RICO API key. Defaults to RICO_API_KEY. Reads work
                without one; anything that acts for you needs it.
        """
        if "private_key" in _legacy:
            raise ValueError(
                "RICO no longer takes a wallet private key. Create an API key at "
                "rico.delivery under Wallet and pass api_key=... instead."
            )
        self.url = (url or os.environ.get("RICO_URL") or DEFAULT_URL).rstrip("/")
        self.api_key = api_key or os.environ.get("RICO_API_KEY")

    def _request(self, method, path, body=None, auth=True):
        """Call the RICO HTTP API. Returns {"status": int, "data": dict}."""
        headers = {}
        if auth:
            if not self.api_key:
                return {"status": 401, "data": {"error": "No RICO API key. Pass api_key=... or set RICO_API_KEY."}}
            headers["Authorization"] = f"Bearer {self.api_key}"
        res = requests.request(method, f"{self.url}{path}", json=body, headers=headers, timeout=30)
        try:
            data = res.json()
        except ValueError:
            data = {"error": f"Unexpected response (HTTP {res.status_code})"}
        return {"status": res.status_code, "data": data}

    def _api_call(self, path, body):
        return self._request("POST", path, body)

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
    ):
        """Post a task on RICO. Returns task ID on success.

        The escrow (fee x runners, plus item cost) comes out of your prepaid
        balance. With too little balance the call returns status 402.

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

    def place_bid(self, task_id, fee, comment="", lat=None, lng=None, trip_km=None):
        """Bid on an open task as a runner."""
        body = {"taskId": task_id, "fee": fee, "comment": comment, "lat": lat, "lng": lng, "tripKm": trip_km}
        return self._api_call("/bid", {k: v for k, v in body.items() if v is not None})

    def accept_bid(self, task_id, bid_id):
        """Accept a runner's bid. A bid above the suggested fee takes the difference from your balance."""
        return self._api_call("/accept-bid", {"taskId": task_id, "bidId": bid_id})

    def confirm_delivery(self, task_id, runner_id=None, rating_score=None, rating_comment=None):
        """Confirm task completion and release the escrow to the runner."""
        body = {"taskId": task_id}
        if runner_id:
            body["runnerId"] = runner_id
        if rating_score:
            body["ratingScore"] = rating_score
        if rating_comment:
            body["ratingComment"] = rating_comment
        return self._api_call("/confirm-delivery", body)

    def cancel_task(self, task_id):
        """Cancel an open task. The escrow returns to your RICO balance."""
        return self._api_call("/cancel-task", {"taskId": task_id})

    def balance(self):
        """Prepaid balance, deposit address and recent activity."""
        return self._request("GET", "/me")

    def claim_deposit(self, tx_hash):
        """Credit a confirmed USDC transfer (Base) from your wallet to the deposit address."""
        return self._api_call("/deposit", {"txHash": tx_hash})

    def list_tasks(self):
        """List all open tasks."""
        return self._request("GET", "/tasks", auth=False)["data"].get("tasks", [])

    def get_task(self, task_id):
        """Get a task with its bids, or None."""
        res = self._request("GET", f"/task?id={task_id}", auth=False)
        return res["data"] if res["status"] == 200 else None

    def health(self):
        """Check if the server is running."""
        res = requests.get(f"{self.url}/health", timeout=30)
        return res.json()
