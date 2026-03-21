"""
Example: Coinbase AgentKit agent with GIGS.MOM tools.

This agent has a wallet on Base (USDC) AND can post tasks for humans
in the physical world via GIGS.MOM.

Requirements:
    pip install coinbase-agentkit coinbase-agentkit-langchain langchain-openai
    pip install requests eth-account

Environment:
    OPENAI_API_KEY=sk-...
    GIGSMOM_URL=https://your-deployment.convex.site
    CDP_API_KEY_NAME=...
    CDP_API_KEY_PRIVATE_KEY=...
"""

import os
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

# ── 1. Coinbase AgentKit (wallet, transfers, swaps) ──
from coinbase_agentkit import AgentKit, AgentKitConfig, CdpWalletConfig
from coinbase_agentkit_langchain import get_langchain_tools

agentkit = AgentKit(AgentKitConfig(
    wallet_config=CdpWalletConfig(network_id="base-mainnet"),
))
wallet_tools = get_langchain_tools(agentkit)

# ── 2. GIGS.MOM tools (post tasks for humans) ──
from langchain_gigsmom import GigsMomToolkit

gigsmom = GigsMomToolkit(
    url=os.environ.get("GIGSMOM_URL", "https://your-deployment.convex.site"),
    # Use the AgentKit wallet's private key for x402 payments
    # Or set GIGSMOM_PRIVATE_KEY env var
)
gigsmom_tools = gigsmom.get_tools()

# ── 3. Combine all tools ──
all_tools = wallet_tools + gigsmom_tools

# ── 4. Create the agent ──
llm = ChatOpenAI(model="gpt-4o")

agent = create_react_agent(
    llm,
    tools=all_tools,
    prompt=(
        "You are an AI agent with a crypto wallet on Base and the ability to "
        "post tasks for humans in the physical world via GIGS.MOM.\n\n"
        "You can:\n"
        "- Check your USDC balance and make transfers\n"
        "- Post tasks for humans: deliveries, moving furniture, gathering info, "
        "verification, negotiations, physical actions\n"
        "- Monitor task status and confirm completion\n"
        "- Pay runners in USDC automatically via x402\n\n"
        "When you need something done in the physical world, use the gigsmom_post_task tool. "
        "For multi-runner tasks (moving, flash mobs), set max_runners > 1.\n"
        "Always include a clear action description and appropriate proof_type."
    ),
)


# ── 5. Run ──
if __name__ == "__main__":
    # Example: agent decides to gather restaurant data
    result = agent.invoke({
        "messages": [
            {
                "role": "user",
                "content": (
                    "I need someone to go to Chez Leon on Rue des Bouchers in Brussels "
                    "and photograph their full menu including prices. "
                    "My poster ID is abc123."
                ),
            }
        ]
    })

    for msg in result["messages"]:
        print(f"\n{msg.type}: {msg.content}")
