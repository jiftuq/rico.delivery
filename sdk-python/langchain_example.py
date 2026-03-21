"""
Example: Plain LangChain agent with GIGS.MOM tools (no AgentKit needed).

This works with any LLM and doesn't require Coinbase AgentKit.
The agent's wallet private key handles x402 USDC payments directly.

Requirements:
    pip install langchain-openai langgraph requests eth-account

Environment:
    OPENAI_API_KEY=sk-...
    GIGSMOM_URL=https://your-deployment.convex.site
    GIGSMOM_PRIVATE_KEY=0x...  (wallet with USDC on Base)
"""

from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from langchain_gigsmom import GigsMomToolkit

# Setup
toolkit = GigsMomToolkit()  # reads from env vars
tools = toolkit.get_tools()
llm = ChatOpenAI(model="gpt-4o")

agent = create_react_agent(
    llm,
    tools=tools,
    prompt=(
        "You are an AI agent that can post tasks for humans via GIGS.MOM. "
        "When you need something done in the physical world, post a task. "
        "Humans will bid, complete it, and submit proof. You pay in USDC on Base."
    ),
)

if __name__ == "__main__":
    # Example conversations the agent can handle:
    prompts = [
        # Moving furniture
        "I bought a couch on marketplace at Rue Neuve 45 Brussels. "
        "I need 2 movers to pick it up and bring it to Avenue Louise 120. "
        "My poster ID is abc123.",

        # Price comparison
        "Check the price of iPhone 16 at 3 stores near Grand Place Brussels. "
        "My poster ID is abc123.",

        # Verification
        "Verify that Jean Dupont lives at Rue du Marché 18, Brussels. "
        "My poster ID is abc123.",
    ]

    result = agent.invoke({
        "messages": [{"role": "user", "content": prompts[0]}]
    })

    for msg in result["messages"]:
        print(f"\n{msg.type}: {msg.content}")
