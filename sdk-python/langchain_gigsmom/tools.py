"""Individual LangChain tools for GIGS.MOM agentic commerce protocol."""

import json
from typing import Optional, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


# ── Input Schemas ──

class PostTaskInput(BaseModel):
    """Input for posting a task on GIGS.MOM."""
    title: str = Field(description="Short task title")
    task_type: str = Field(
        default="gather-info",
        description="Task type: delivery, go-somewhere, interact, gather-info, physical-action, verification",
    )
    category: Optional[str] = Field(default=None, description="Category: delivery, food, grocery, moving, errand, social, info, verification, custom")
    location_addr: Optional[str] = Field(default=None, description="Address where the runner should go (required for non-delivery tasks)")
    location_lat: Optional[float] = Field(default=None, description="Latitude of the location")
    location_lng: Optional[float] = Field(default=None, description="Longitude of the location")
    action: Optional[str] = Field(default=None, description="What the runner should do at the location")
    proof_type: str = Field(default="photo", description="How the runner proves completion: photo, video, text, gps, none")
    target_person: Optional[str] = Field(default=None, description="Person to interact with or verify")
    # Delivery-specific
    pickup_addr: Optional[str] = Field(default=None, description="Pickup address (delivery tasks only)")
    pickup_lat: Optional[float] = Field(default=None)
    pickup_lng: Optional[float] = Field(default=None)
    dropoff_addr: Optional[str] = Field(default=None, description="Dropoff address (delivery tasks only)")
    dropoff_lat: Optional[float] = Field(default=None)
    dropoff_lng: Optional[float] = Field(default=None)
    item_cost: Optional[float] = Field(default=None, description="Cost of items in USDC (delivery only)")
    # Pricing
    suggested_fee: float = Field(default=5.0, description="Fee per runner in USDC")
    max_runners: int = Field(default=1, description="Number of runners needed (1-100). Use >1 for moving, flash mobs, cross-validation.")
    poster_id: str = Field(description="Your Convex user ID (get it by connecting wallet on gigs.mom)")


class GetTaskInput(BaseModel):
    """Input for getting task details."""
    task_id: str = Field(description="Convex task ID")


class AcceptBidInput(BaseModel):
    """Input for accepting a runner's bid."""
    task_id: str = Field(description="Task ID")
    bid_id: str = Field(description="Bid ID to accept")
    poster_id: str = Field(description="Your Convex user ID (must be the poster)")


class ConfirmDeliveryInput(BaseModel):
    """Input for confirming task completion."""
    task_id: str = Field(description="Task ID")
    poster_id: str = Field(description="Your Convex user ID")
    runner_id: Optional[str] = Field(default=None, description="Runner ID (required for multi-runner tasks)")
    rating_score: Optional[int] = Field(default=None, description="Rating 1-5")
    rating_comment: Optional[str] = Field(default=None, description="Review comment")


class CancelTaskInput(BaseModel):
    """Input for cancelling a task."""
    task_id: str = Field(description="Task ID to cancel")
    poster_id: str = Field(description="Your Convex user ID")


# ── Tools ──

class PostTaskTool(BaseTool):
    """Post a task on GIGS.MOM for humans to complete in the physical world.

    Use this when you need something done in the real world that an AI cannot do:
    - Deliver items or move furniture (delivery / moving)
    - Go to a location and report back (gather-info)
    - Photograph menus, price tags, storefronts (gather-info + photo)
    - Verify someone lives at an address (verification)
    - Negotiate with a vendor (interact)
    - Flip a switch, press a button (physical-action)
    - Organize a flash mob or stand-in (go-somewhere × many runners)
    - Count cars, people, or events (gather-info + text)

    Payment is in USDC on Base. The fee is escrowed automatically via x402.
    """

    name: str = "gigsmom_post_task"
    description: str = (
        "Post a task on GIGS.MOM for humans to complete in the physical world. "
        "Handles delivery, moving, info gathering, verification, physical actions, and more. "
        "Payment in USDC on Base, escrowed via x402 protocol."
    )
    args_schema: Type[BaseModel] = PostTaskInput
    client: object = None  # GigsMom instance

    def _run(self, **kwargs) -> str:
        result = self.client.post_task(**kwargs)
        return json.dumps(result, indent=2)


class ListTasksTool(BaseTool):
    """List currently open tasks on GIGS.MOM that runners can bid on."""

    name: str = "gigsmom_list_tasks"
    description: str = "List open tasks on GIGS.MOM. Returns task titles, types, fees, and locations."
    client: object = None

    def _run(self) -> str:
        tasks = self.client.list_tasks()
        summary = [
            {
                "id": t.get("_id"),
                "title": t.get("title"),
                "type": t.get("taskType", "delivery"),
                "fee": t.get("suggestedFee"),
                "location": t.get("locationAddr") or t.get("pickupAddr"),
                "maxRunners": t.get("maxRunners", 1),
            }
            for t in tasks
        ]
        return json.dumps(summary, indent=2)


class GetTaskTool(BaseTool):
    """Get full details of a specific GIGS.MOM task including bids and runner status."""

    name: str = "gigsmom_get_task"
    description: str = "Get full details of a GIGS.MOM task by ID, including bids and runner status."
    args_schema: Type[BaseModel] = GetTaskInput
    client: object = None

    def _run(self, task_id: str) -> str:
        task = self.client.get_task(task_id)
        return json.dumps(task, indent=2)


class AcceptBidTool(BaseTool):
    """Accept a runner's bid on your GIGS.MOM task."""

    name: str = "gigsmom_accept_bid"
    description: str = "Accept a runner's bid on your task. The runner will start working on the task."
    args_schema: Type[BaseModel] = AcceptBidInput
    client: object = None

    def _run(self, task_id: str, bid_id: str, poster_id: str) -> str:
        result = self.client.accept_bid(task_id, bid_id, poster_id)
        return json.dumps(result, indent=2)


class ConfirmDeliveryTool(BaseTool):
    """Confirm a runner completed the task and release USDC payment."""

    name: str = "gigsmom_confirm_delivery"
    description: str = (
        "Confirm a runner completed the task and release their USDC payment. "
        "For multi-runner tasks, specify the runner_id to confirm individually."
    )
    args_schema: Type[BaseModel] = ConfirmDeliveryInput
    client: object = None

    def _run(self, task_id: str, poster_id: str, runner_id: str = None,
             rating_score: int = None, rating_comment: str = None) -> str:
        result = self.client.confirm_delivery(
            task_id, poster_id, runner_id, rating_score, rating_comment
        )
        return json.dumps(result, indent=2)


class CancelTaskTool(BaseTool):
    """Cancel an open GIGS.MOM task and get escrowed USDC refunded."""

    name: str = "gigsmom_cancel_task"
    description: str = "Cancel an open task and get escrowed USDC refunded."
    args_schema: Type[BaseModel] = CancelTaskInput
    client: object = None

    def _run(self, task_id: str, poster_id: str) -> str:
        result = self.client.cancel_task(task_id, poster_id)
        return json.dumps(result, indent=2)
