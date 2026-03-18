FROM python:3.12-slim
WORKDIR /app
RUN pip install uv
COPY pyproject.toml .
RUN uv pip install --system -e .
COPY . .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
CMD ["sh", "entrypoint.sh"]
