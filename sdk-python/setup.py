from setuptools import setup, find_packages

setup(
    name="langchain-gigsmom",
    version="0.2.0",
    description="LangChain toolkit for GIGS.MOM — let AI agents post tasks for humans in the physical world",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="GIGS.MOM",
    url="https://github.com/jiftuq/dropzone",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "requests>=2.28.0",
        "langchain-core>=0.2.0",
    ],
    extras_require={
        "x402": ["eth-account>=0.11.0"],
        "agentkit": ["coinbase-agentkit", "coinbase-agentkit-langchain"],
        "langchain": ["langchain-openai", "langgraph"],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries",
        "Programming Language :: Python :: 3",
    ],
)
