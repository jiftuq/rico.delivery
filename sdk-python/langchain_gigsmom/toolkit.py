"""GIGS.MOM LangChain Toolkit — plug into any LangChain agent or Coinbase AgentKit."""

import os
from typing import List

from langchain_core.tools import BaseTool

from langchain_gigsmom.tools import (
    PostTaskTool,
    ListTasksTool,
    GetTaskTool,
    AcceptBidTool,
    ConfirmDeliveryTool,
    CancelTaskTool,
)

# Import GigsMom client from parent package
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from gigsmom import GigsMom


class GigsMomToolkit:
    """LangChain toolkit for GIGS.MOM agentic commerce protocol.

    Gives any LangChain agent (including Coinbase AgentKit) the ability to
    post tasks for humans in the physical world and pay in USDC on Base.

    Usage with any LangChain agent:
        from langchain_gigsmom import GigsMomToolkit

        toolkit = GigsMomToolkit(
            url="https://your-deployment.convex.site",
            private_key="0x...",
        )
        tools = toolkit.get_tools()
        # Add tools to your agent

    Usage with Coinbase AgentKit:
        from coinbase_agentkit import AgentKit
        from coinbase_agentkit_langchain import get_langchain_tools
        from langchain_gigsmom import GigsMomToolkit

        # AgentKit tools (wallet, transfers, swaps, etc.)
        agentkit = AgentKit()
        tools = get_langchain_tools(agentkit)

        # Add GIGS.MOM tools (post tasks for humans)
        gigsmom = GigsMomToolkit(private_key=agentkit.wallet.default_address.export_key())
        tools.extend(gigsmom.get_tools())
    """

    def __init__(self, url: str = None, private_key: str = None):
        self.client = GigsMom(url=url, private_key=private_key)

    def get_tools(self) -> List[BaseTool]:
        """Return all GIGS.MOM tools for use in a LangChain agent."""
        return [
            PostTaskTool(client=self.client),
            ListTasksTool(client=self.client),
            GetTaskTool(client=self.client),
            AcceptBidTool(client=self.client),
            ConfirmDeliveryTool(client=self.client),
            CancelTaskTool(client=self.client),
        ]
