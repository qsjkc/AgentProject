from __future__ import annotations

import asyncio
import logging
import re
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from app.config import Settings
from app.schemas import ChatCompletionRequest
from app.tools import BackendToolClient

logger = logging.getLogger("voice_agent_server")

GENERIC_WEATHER_WORDS = {
    "\u5929\u6c14",
    "\u6c14\u6e29",
    "\u6e29\u5ea6",
    "\u4eca\u5929",
    "\u4eca\u65e5",
    "\u73b0\u5728",
    "\u5f53\u524d",
    "\u672c\u5730",
    "\u8fd9\u91cc",
    "\u8fd9\u8fb9",
    "\u600e\u4e48\u6837",
}

TIME_KEYWORDS = (
    "\u51e0\u70b9",
    "\u65f6\u95f4",
    "\u65e5\u671f",
    "\u661f\u671f",
    "time",
    "date",
)

WEATHER_KEYWORDS = (
    "\u5929\u6c14",
    "\u6c14\u6e29",
    "\u6e29\u5ea6",
    "\u4e0b\u96e8",
    "\u6674",
    "\u591a\u4e91",
    "weather",
    "temperature",
)

PLATFORM_KEYWORDS = (
    "\u5e73\u53f0",
    "\u540e\u7aef",
    "\u7cfb\u7edf",
    "\u670d\u52a1",
    "service",
    "backend",
    "platform",
)

STATUS_KEYWORDS = (
    "\u72b6\u6001",
    "\u6b63\u5e38",
    "\u53ef\u7528",
    "\u5065\u5eb7",
    "ready",
    "status",
    "health",
)

IDENTITY_KEYWORDS = (
    "\u4f60\u662f\u8c01",
    "who are you",
    "\u4ecb\u7ecd\u4e00\u4e0b\u4f60\u81ea\u5df1",
)

GREETING_KEYWORDS = (
    "\u4f60\u597d",
    "\u60a8\u597d",
    "\u54c8\u55bd",
    "hello",
    "hi",
    "\u5582\u4f60\u597d",
)

HELP_KEYWORDS = (
    "\u5e2e\u52a9",
    "help",
    "\u4f60\u80fd\u505a\u4ec0\u4e48",
    "\u652f\u6301\u4ec0\u4e48",
    "\u600e\u4e48\u7528",
)

SUPPORT_KEYWORDS = (
    "\u6709\u95ee\u9898",
    "\u51fa\u95ee\u9898",
    "\u4e0d\u56de\u7b54",
    "\u6ca1\u58f0\u97f3",
    "\u6ca1\u53cd\u5e94",
    "\u542c\u4e0d\u5230",
    "\u5f02\u5e38",
    "error",
)


class AgentState(TypedDict, total=False):
    prompt: str
    previous_user_prompts: list[str]
    chat_messages: list[dict[str, str]]
    tool_name: str
    city: str
    tool_output: str
    final_text: str


class VoiceDemoAgent:
    def __init__(self, settings: Settings, tools: BackendToolClient | None = None) -> None:
        self._settings = settings
        self._tools = tools or BackendToolClient(settings)
        self._graph = self._build_graph()

    def _build_graph(self):
        graph = StateGraph(AgentState)
        graph.add_node("route", self._route_node)
        graph.add_node("time_tool", self._time_tool_node)
        graph.add_node("weather_tool", self._weather_tool_node)
        graph.add_node("platform_tool", self._platform_tool_node)
        graph.add_node("greeting_tool", self._greeting_tool_node)
        graph.add_node("identity_tool", self._identity_tool_node)
        graph.add_node("help_tool", self._help_tool_node)
        graph.add_node("support_tool", self._support_tool_node)
        graph.add_node("project_chat_tool", self._project_chat_tool_node)
        graph.add_node("silent_tool", self._silent_tool_node)
        graph.add_node("respond", self._respond_node)

        graph.add_edge(START, "route")
        graph.add_conditional_edges(
            "route",
            self._next_node,
            {
                "time_tool": "time_tool",
                "weather_tool": "weather_tool",
                "platform_tool": "platform_tool",
                "greeting_tool": "greeting_tool",
                "identity_tool": "identity_tool",
                "help_tool": "help_tool",
                "support_tool": "support_tool",
                "project_chat_tool": "project_chat_tool",
                "silent_tool": "silent_tool",
            },
        )
        graph.add_edge("time_tool", "respond")
        graph.add_edge("weather_tool", "respond")
        graph.add_edge("platform_tool", "respond")
        graph.add_edge("greeting_tool", "respond")
        graph.add_edge("identity_tool", "respond")
        graph.add_edge("help_tool", "respond")
        graph.add_edge("support_tool", "respond")
        graph.add_edge("project_chat_tool", "respond")
        graph.add_edge("silent_tool", "respond")
        graph.add_edge("respond", END)
        return graph.compile()

    def _latest_user_prompt(self, request: ChatCompletionRequest) -> str:
        for message in reversed(request.messages):
            if message.role == "user" and message.content.strip():
                return message.content.strip()
        return ""

    def _user_prompts(self, request: ChatCompletionRequest) -> list[str]:
        return [message.content.strip() for message in request.messages if message.role == "user" and message.content.strip()]

    def _chat_messages(self, request: ChatCompletionRequest) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        for message in request.messages[-10:]:
            content = message.content.strip()
            if not content or message.role not in {"user", "assistant", "system"}:
                continue
            messages.append({"role": message.role, "content": content[:1200]})
        return messages

    def _contains_any(self, text: str, keywords: tuple[str, ...]) -> bool:
        return any(keyword in text for keyword in keywords)

    def _normalize_city_candidate(self, candidate: str) -> str | None:
        normalized = candidate.strip()
        normalized = re.sub(r"^(?:\u90a3|\u90a3\u4e48|\u8fd8\u6709|\u6362\u6210|\u518d\u67e5|what about|how about)\s*", "", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"(?:\u5462|\u5417|\u5427|\u600e\u4e48\u6837|how about|what about)$", "", normalized, flags=re.IGNORECASE)
        normalized = re.sub(
            r"^(?:\u5e2e\u6211|\u8bf7|\u9ebb\u70e6\u4f60?|\u60f3\u77e5\u9053|\u544a\u8bc9\u6211|\u6211\u60f3\u77e5\u9053|\u5e2e\u5fd9)?",
            "",
            normalized,
        )
        normalized = re.sub(
            r"^(?:\u67e5\u8be2\u4e00\u4e0b|\u67e5\u4e00\u4e0b|\u67e5\u4e00\u67e5|\u67e5\u67e5|\u67e5\u8be2|\u770b\u770b|\u770b\u4e00\u4e0b|\u770b\u4e00\u770b)",
            "",
            normalized,
        )
        normalized = re.sub(
            r"(?:\u4eca\u5929|\u4eca\u65e5|\u73b0\u5728|\u5f53\u524d|\u6b64\u523b|\u76ee\u524d|\u8fd9\u4f1a\u513f|\u4e00\u4e0b)(?:\u7684)?$",
            "",
            normalized,
        )
        normalized = re.sub(r"\u7684$", "", normalized)
        normalized = normalized.strip(" ，。！？、:：;；")
        normalized = re.sub(r"(?:\u7684)?(?:\u5929\u6c14|\u6c14\u6e29|\u6e29\u5ea6)$", "", normalized)
        normalized = normalized.strip(" ，。！？、:：;；")
        if not normalized or normalized in GENERIC_WEATHER_WORDS:
            return None
        if len(normalized) < 2:
            return None
        return normalized

    def _extract_followup_city(self, prompt: str) -> str | None:
        text = re.sub(r"\s+", " ", prompt.strip())
        text = re.sub(
            r"(?:\u5929\u6c14|\u6c14\u6e29|\u6e29\u5ea6|\u4eca\u5929|\u4eca\u65e5|\u73b0\u5728|\u5f53\u524d|\u5462|\u5417|\u5427|\u600e\u4e48\u6837|[?？!！。])",
            "",
            text,
        )
        candidate = self._normalize_city_candidate(text)
        if candidate:
            return candidate

        english_match = re.search(r"(?P<city>[A-Za-z][A-Za-z\s-]{1,40})", prompt)
        if english_match:
            return self._normalize_city_candidate(english_match.group("city"))
        return None

    def _extract_weather_city(self, prompt: str) -> str | None:
        text = re.sub(r"\s+", " ", prompt.strip())

        chinese_patterns = (
            r"(?P<city>[\u4e00-\u9fff]{2,12}?)(?:\u5e02|\u533a|\u53bf|\u5dde|\u7701)?(?:\u4eca\u5929|\u4eca\u65e5|\u73b0\u5728|\u5f53\u524d|\u6b64\u523b)?(?:\u7684)?(?:\u5929\u6c14|\u6c14\u6e29|\u6e29\u5ea6)",
            r"(?:\u5e2e\u6211|\u8bf7|\u9ebb\u70e6\u4f60?|\u60f3\u77e5\u9053|\u544a\u8bc9\u6211|\u6211\u60f3\u77e5\u9053)?(?:\u67e5\u8be2\u4e00\u4e0b|\u67e5\u4e00\u4e0b|\u67e5\u4e00\u67e5|\u67e5\u67e5|\u67e5\u8be2|\u770b\u770b|\u770b\u4e00\u4e0b|\u770b\u4e00\u770b)?(?P<city>[\u4e00-\u9fff]{2,12}?)(?:\u5e02|\u533a|\u53bf|\u5dde|\u7701)?(?:\u4eca\u5929|\u4eca\u65e5|\u73b0\u5728|\u5f53\u524d|\u6b64\u523b)?(?:\u7684)?(?:\u5929\u6c14|\u6c14\u6e29|\u6e29\u5ea6)",
        )
        for pattern in chinese_patterns:
            match = re.search(pattern, text)
            if not match:
                continue
            candidate = self._normalize_city_candidate(match.group("city"))
            if candidate:
                return candidate

        english_match = re.search(
            r"(?:weather|temperature)\s+(?:in\s+)?(?P<city>[A-Za-z][A-Za-z\s-]{1,40})",
            text,
            re.IGNORECASE,
        )
        if english_match:
            candidate = self._normalize_city_candidate(english_match.group("city"))
            if candidate:
                return candidate
        return None

    def _previous_weather_city(self, previous_user_prompts: list[str]) -> str | None:
        for previous_prompt in reversed(previous_user_prompts[-6:]):
            lowered = previous_prompt.lower()
            if self._contains_any(lowered, WEATHER_KEYWORDS):
                city = self._extract_weather_city(previous_prompt)
                if city:
                    return city
        return None

    def _is_weather_followup(self, prompt: str, previous_user_prompts: list[str]) -> bool:
        if not previous_user_prompts:
            return False
        previous_was_weather = any(
            self._contains_any(previous_prompt.lower(), WEATHER_KEYWORDS)
            for previous_prompt in previous_user_prompts[-4:]
        )
        if not previous_was_weather:
            return False

        lowered = prompt.lower()
        if self._contains_any(lowered, TIME_KEYWORDS) or self._contains_any(lowered, PLATFORM_KEYWORDS):
            return False
        if self._extract_followup_city(prompt):
            return True
        return any(marker in lowered for marker in ("\u5462", "\u90a3", "\u8fd8\u6709", "\u6362\u6210", "what about", "how about"))

    def _route_node(self, state: AgentState) -> AgentState:
        prompt = state.get("prompt", "").strip()
        previous_user_prompts = state.get("previous_user_prompts", [])
        lowered = prompt.lower()

        if self._contains_any(lowered, TIME_KEYWORDS):
            route_state: AgentState = {"tool_name": "time_tool"}
        elif self._contains_any(lowered, WEATHER_KEYWORDS):
            route_state = {
                "tool_name": "weather_tool",
                "city": self._extract_weather_city(prompt) or "Beijing",
            }
        elif self._is_weather_followup(prompt, previous_user_prompts):
            route_state = {
                "tool_name": "weather_tool",
                "city": self._extract_followup_city(prompt) or self._previous_weather_city(previous_user_prompts) or "Beijing",
            }
        elif (
            self._contains_any(lowered, PLATFORM_KEYWORDS)
            and self._contains_any(lowered, STATUS_KEYWORDS)
        ) or self._contains_any(lowered, ("\u5e73\u53f0\u73b0\u5728\u6b63\u5e38\u5417", "platform status")):
            route_state = {"tool_name": "platform_tool"}
        elif self._contains_any(lowered, IDENTITY_KEYWORDS):
            route_state = {"tool_name": "identity_tool"}
        elif self._contains_any(lowered, GREETING_KEYWORDS):
            route_state = {"tool_name": "greeting_tool"}
        elif self._contains_any(lowered, HELP_KEYWORDS):
            route_state = {"tool_name": "help_tool"}
        elif self._contains_any(lowered, SUPPORT_KEYWORDS):
            route_state = {"tool_name": "support_tool"}
        else:
            route_state = {"tool_name": "project_chat_tool"}

        logger.info(
            "agent_route tool=%s city=%s prompt=%s",
            route_state.get("tool_name"),
            route_state.get("city"),
            prompt[:120],
        )
        return route_state

    def _next_node(self, state: AgentState) -> str:
        return state.get("tool_name", "silent_tool")

    async def _time_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": await self._run_tool(
                self._tools.get_current_time,
                "\u73b0\u5728\u65f6\u95f4\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002",
            )
        }

    async def _weather_tool_node(self, state: AgentState) -> AgentState:
        city = state.get("city") or "Beijing"
        return {
            "tool_output": await self._run_tool(
                lambda: self._tools.get_demo_weather(city),
                "\u5929\u6c14\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002",
            )
        }

    async def _platform_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": await self._run_tool(
                self._tools.get_platform_status,
                "\u5e73\u53f0\u72b6\u6001\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002",
            )
        }

    async def _greeting_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": "\u4f60\u597d\uff0c\u6211\u53ef\u4ee5\u966a\u4f60\u804a\u65e5\u5e38\u95ee\u9898\uff0c\u4e5f\u53ef\u4ee5\u5e2e\u4f60\u67e5\u65f6\u95f4\u3001\u5929\u6c14\u548c\u5e73\u53f0\u72b6\u6001\u3002"
        }

    async def _identity_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": "\u6211\u662f Detachym \u684c\u5ba0\u8bed\u97f3\u52a9\u624b\uff0c\u53ef\u4ee5\u7528\u8bed\u97f3\u548c\u5b57\u5e55\u56de\u7b54\u65e5\u5e38\u95ee\u9898\uff0c\u4e5f\u80fd\u67e5\u8be2\u65f6\u95f4\u3001\u5929\u6c14\u548c\u5e73\u53f0\u72b6\u6001\u3002"
        }

    async def _help_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": "\u4f60\u53ef\u4ee5\u76f4\u63a5\u95ee\u65e5\u5e38\u95ee\u9898\uff0c\u6bd4\u5982\u65e9\u9910\u5efa\u8bae\u3001\u5e38\u8bc6\u89e3\u91ca\u3001\u7b80\u5355\u8ba1\u5212\uff1b\u4e5f\u53ef\u4ee5\u95ee\u73b0\u5728\u51e0\u70b9\u3001\u67d0\u4e2a\u57ce\u5e02\u5929\u6c14\u3001\u5e73\u53f0\u72b6\u6001\u3002"
        }

    async def _support_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": "\u5982\u679c\u521a\u624d\u6ca1\u6709\u542c\u5230\u56de\u7b54\uff0c\u8bf7\u786e\u8ba4\u684c\u9762\u7aef\u5df2\u9009\u62e9\u8bed\u97f3\u52a0\u6587\u672c\u6a21\u5f0f\uff0c\u7136\u540e\u91cd\u8fde\u518d\u95ee\u4e00\u6b21\u3002"
        }

    async def _project_chat_tool_node(self, state: AgentState) -> AgentState:
        return {
            "tool_output": await self._run_tool(
                lambda: self._tools.get_project_chat(state.get("chat_messages", [])),
                "\u8fd9\u4e2a\u95ee\u9898\u6211\u73b0\u5728\u6ca1\u6709\u62ff\u5230\u7a33\u5b9a\u7684\u6a21\u578b\u56de\u7b54\u3002\u4f60\u53ef\u4ee5\u6362\u4e2a\u8bf4\u6cd5\u518d\u95ee\u4e00\u6b21\uff0c\u6211\u4f1a\u7ee7\u7eed\u5c1d\u8bd5\u56de\u7b54\u3002",
            )
        }

    async def _silent_tool_node(self, _: AgentState) -> AgentState:
        return {
            "tool_output": "\u8fd9\u4e2a\u95ee\u9898\u6211\u73b0\u5728\u8fd8\u4e0d\u80fd\u7a33\u5b9a\u5904\u7406\u3002\u4f60\u53ef\u4ee5\u6362\u4e2a\u8bf4\u6cd5\u518d\u95ee\u4e00\u6b21\uff0c\u6211\u4f1a\u5c3d\u91cf\u7ed9\u51fa\u7b80\u77ed\u53ef\u64ad\u62a5\u7684\u56de\u7b54\u3002"
        }

    def _respond_node(self, state: AgentState) -> AgentState:
        if "tool_output" in state:
            return {"final_text": state["tool_output"]}
        return {"final_text": "\u6211\u6682\u65f6\u6ca1\u6709\u6574\u7406\u51fa\u53ef\u64ad\u62a5\u7684\u7ed3\u679c\u3002"}

    async def _run_tool(self, tool_func, fallback_text: str) -> str:
        try:
            return await asyncio.wait_for(tool_func(), timeout=self._settings.tool_timeout_seconds)
        except asyncio.TimeoutError:
            logger.warning(
                "tool_timeout tool=%s timeout_ms=%s",
                getattr(tool_func, "__name__", tool_func.__class__.__name__),
                self._settings.AGENT_TOOL_TIMEOUT_MS,
            )
            return fallback_text
        except Exception as exc:  # pragma: no cover - logged and converted to natural language
            logger.warning("tool_failure tool=%s error=%s", getattr(tool_func, "__name__", tool_func.__class__.__name__), exc)
            return fallback_text

    async def complete_text(self, request: ChatCompletionRequest) -> str:
        prompt = self._latest_user_prompt(request)
        if not prompt:
            return ""
        user_prompts = self._user_prompts(request)
        chat_messages = self._chat_messages(request)

        try:
            state = await asyncio.wait_for(
                self._graph.ainvoke(
                    {
                        "prompt": prompt,
                        "previous_user_prompts": user_prompts[:-1],
                        "chat_messages": chat_messages,
                    }
                ),
                timeout=self._settings.total_timeout_seconds,
            )
        except asyncio.TimeoutError:
            logger.warning("agent_total_timeout timeout_ms=%s", self._settings.AGENT_TOTAL_TIMEOUT_MS)
            return "\u6211\u8fd9\u8fb9\u54cd\u5e94\u8d85\u65f6\u4e86\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u4e00\u6b21\u3002"
        except Exception:  # pragma: no cover - defensive guard
            logger.exception("agent_unhandled_error")
            return "\u6211\u73b0\u5728\u6682\u65f6\u5904\u7406\u4e0d\u4e86\u8fd9\u4e2a\u8bf7\u6c42\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002"

        if "final_text" in state:
            return str(state["final_text"])
        return "\u6211\u6682\u65f6\u6ca1\u6709\u6574\u7406\u51fa\u53ef\u64ad\u62a5\u7684\u7ed3\u679c\u3002"
