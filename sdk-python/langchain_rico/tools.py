"""Individual LangChain tools for RICO agentic commerce protocol."""

import json
from typing import Optional, List, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


# ── Input Schemas ──

class WorkflowStep(BaseModel):
    """A single step in a RICO workflow."""
    action: str = Field(description="What the runner should do at this step")
    location_addr: Optional[str] = Field(default=None, description="Address for this step")
    location_lat: Optional[float] = Field(default=None, description="Latitude")
    location_lng: Optional[float] = Field(default=None, description="Longitude")
    proof_type: Optional[str] = Field(default=None, description="Proof required: photo, video, text, gps, none")
    requirements: Optional[str] = Field(default=None, description="Equipment needed: van, camera, ID, etc.")


class PostTaskInput(BaseModel):
    """Input for posting a workflow-based task on RICO.

    Tasks are workflows: ordered sequences of steps. Each step has an action,
    optional location, proof type, and requirements. The runner completes them in order.

    Example steps for a food delivery:
        [{"action": "Go to restaurant", "location_addr": "123 Main St", "proof_type": "gps"},
         {"action": "Pick up order #412", "proof_type": "photo"},
         {"action": "Deliver to customer", "location_addr": "456 Oak Ave", "proof_type": "photo"}]

    Example steps for moving:
        [{"action": "Come to my apartment", "location_addr": "...", "requirements": "van"},
         {"action": "Load furniture", "proof_type": "photo"},
         {"action": "Drive to new place", "location_addr": "..."},
         {"action": "Unload furniture", "proof_type": "photo"}]
    """
    title: str = Field(description="Short task title")
    steps: Optional[List[WorkflowStep]] = Field(
        default=None,
        description="Workflow steps (preferred). Each step: action, location, proof_type, requirements."
    )
    task_type: str = Field(
        default="gather-info",
        description="Task type: delivery, go-somewhere, interact, gather-info, physical-action, verification",
    )
    category: Optional[str] = Field(default=None, description="Category: delivery, food, grocery, moving, errand, social, info, verification, custom")
    # Legacy flat fields (use steps instead when possible)
    location_addr: Optional[str] = Field(default=None, description="Single location address (use steps instead for multi-step)")
    location_lat: Optional[float] = Field(default=None)
    location_lng: Optional[float] = Field(default=None)
    action: Optional[str] = Field(default=None, description="Single action (use steps instead)")
    proof_type: str = Field(default="photo", description="Default proof type: photo, video, text, gps, none")
    target_person: Optional[str] = Field(default=None, description="Person to interact with or verify")
    pickup_addr: Optional[str] = Field(default=None, description="Pickup address (delivery without steps)")
    pickup_lat: Optional[float] = Field(default=None)
    pickup_lng: Optional[float] = Field(default=None)
    dropoff_addr: Optional[str] = Field(default=None, description="Dropoff address (delivery without steps)")
    dropoff_lat: Optional[float] = Field(default=None)
    dropoff_lng: Optional[float] = Field(default=None)
    item_cost: Optional[float] = Field(default=None, description="Cost of items in USDC (delivery only)")
    # Pricing
    suggested_fee: float = Field(default=5.0, description="Fee per runner in USDC")
    max_runners: int = Field(default=1, description="Number of runners needed (1-100). Use >1 for moving, flash mobs, cross-validation.")
    poster_id: str = Field(description="Your Convex user ID (get it by connecting wallet on rico.delivery)")


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
    """Post a workflow-based task on RICO for humans to complete in the physical world.

    Every task is a workflow: an ordered sequence of steps. Each step has an action,
    optional location, proof requirement, and equipment requirements.

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
    Always prefer using 'steps' to define the workflow rather than flat fields.
    """

    name: str = "rico_post_task"
    description: str = (
        "Post a workflow-based task on RICO for humans to complete in the physical world. "
        "Define the task as a sequence of steps (action, location, proof_type, requirements). "
        "Handles delivery, moving, info gathering, verification, physical actions, and more. "
        "Payment in USDC on Base, escrowed via x402 protocol."
    )
    args_schema: Type[BaseModel] = PostTaskInput
    client: object = None  # Rico instance

    def _run(self, **kwargs) -> str:
        # Convert Pydantic WorkflowStep models to dicts
        if kwargs.get("steps"):
            kwargs["steps"] = [
                s.model_dump(exclude_none=True) if hasattr(s, "model_dump") else s
                for s in kwargs["steps"]
            ]
        result = self.client.post_task(**kwargs)
        return json.dumps(result, indent=2)


class ListTasksTool(BaseTool):
    """List currently open tasks on RICO that runners can bid on."""

    name: str = "rico_list_tasks"
    description: str = "List open tasks on RICO. Returns task titles, types, fees, and locations."
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
    """Get full details of a specific RICO task including bids and runner status."""

    name: str = "rico_get_task"
    description: str = "Get full details of a RICO task by ID, including bids and runner status."
    args_schema: Type[BaseModel] = GetTaskInput
    client: object = None

    def _run(self, task_id: str) -> str:
        task = self.client.get_task(task_id)
        return json.dumps(task, indent=2)


class AcceptBidTool(BaseTool):
    """Accept a runner's bid on your RICO task."""

    name: str = "rico_accept_bid"
    description: str = "Accept a runner's bid on your task. The runner will start working on the task."
    args_schema: Type[BaseModel] = AcceptBidInput
    client: object = None

    def _run(self, task_id: str, bid_id: str, poster_id: str) -> str:
        result = self.client.accept_bid(task_id, bid_id, poster_id)
        return json.dumps(result, indent=2)


class ConfirmDeliveryTool(BaseTool):
    """Confirm a runner completed the task and release USDC payment."""

    name: str = "rico_confirm_delivery"
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
    """Cancel an open RICO task and get escrowed USDC refunded."""

    name: str = "rico_cancel_task"
    description: str = "Cancel an open task and get escrowed USDC refunded."
    args_schema: Type[BaseModel] = CancelTaskInput
    client: object = None

    def _run(self, task_id: str, poster_id: str) -> str:
        result = self.client.cancel_task(task_id, poster_id)
        return json.dumps(result, indent=2)
