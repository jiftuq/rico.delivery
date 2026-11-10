"""RICO LangChain Toolkit — plug into any LangChain agent or Coinbase AgentKit."""

import os
from typing import List

from langchain_core.tools import BaseTool

from langchain_rico.tools import (
    PostTaskTool,
    ListTasksTool,
    GetTaskTool,
    AcceptBidTool,
    ConfirmDeliveryTool,
    CancelTaskTool,
)

# Import Rico client from parent package
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from rico import Rico


class RicoToolkit:
    """LangChain toolkit for RICO agentic commerce protocol.

    Gives any LangChain agent (including Coinbase AgentKit) the ability to
    post tasks for humans in the physical world, paid from a prepaid USDC balance.

    Usage with any LangChain agent:
        from langchain_rico import RicoToolkit

        toolkit = RicoToolkit(api_key="rico_...")  # from rico.delivery under Wallet
        tools = toolkit.get_tools()
        # Add tools to your agent

    Usage with Coinbase AgentKit:
        from coinbase_agentkit import AgentKit
        from coinbase_agentkit_langchain import get_langchain_tools
        from langchain_rico import RicoToolkit

        # AgentKit tools (wallet, transfers, swaps, etc.)
        agentkit = AgentKit()
        tools = get_langchain_tools(agentkit)

        # Add RICO tools (post tasks for humans)
        rico = RicoToolkit(api_key="rico_...")
        tools.extend(rico.get_tools())
    """

    def __init__(self, url: str = None, api_key: str = None):
        self.client = Rico(url=url, api_key=api_key)

    def get_tools(self) -> List[BaseTool]:
        """Return all RICO tools for use in a LangChain agent."""
        return [
            PostTaskTool(client=self.client),
            ListTasksTool(client=self.client),
            GetTaskTool(client=self.client),
            AcceptBidTool(client=self.client),
            ConfirmDeliveryTool(client=self.client),
            CancelTaskTool(client=self.client),
        ]
