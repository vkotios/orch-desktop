// Stateless mapping between Claude stream-json frames and native RPC envelopes.
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const idOk = (v) => typeof v === "string" && v.length > 0 && v.length <= 128;
const methodOk = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;
const requireId = (id) => { if (!idOk(id)) throw new Error("Claude control request id must be a bounded nonempty string"); };

function validContent(content) {
  if (typeof content === "string") return content.length > 0;
  return Array.isArray(content) && content.length > 0 && content.every((part) =>
    plain(part) && methodOk(part.type) && (part.type !== "text" || (typeof part.text === "string" && part.text.length > 0)));
}

export const claudeWireCodec = Object.freeze({
  encode(envelope) {
    if (Object.hasOwn(envelope, "method")) {
      const { id, method, params } = envelope;
      if (!methodOk(method)) throw new Error("invalid Claude method");
      if (Object.hasOwn(envelope, "id")) {
        requireId(id);
        if (params !== undefined && (!plain(params) || Object.hasOwn(params, "subtype"))) throw new Error("invalid Claude control parameters");
        return { type: "control_request", request_id: id, request: { ...params, subtype: method } };
      }
      if (method !== "claude/user" || !plain(params) || params.type !== "user" || !idOk(params.uuid) || !idOk(params.session_id) || params.parent_tool_use_id !== null || params.client_composed !== true || !plain(params.message) || params.message.role !== "user" || !validContent(params.message.content)) {
        throw new Error("invalid Claude user notification");
      }
      return params;
    }
    requireId(envelope.id);
    if (!Object.hasOwn(envelope, "result") || !plain(envelope.result)) throw new Error("Claude control response requires an object result");
    return { type: "control_response", response: { subtype: "success", request_id: envelope.id, response: envelope.result } };
  },
  decode(envelope) {
    const type = envelope.type;
    if (!methodOk(type)) throw new Error("invalid Claude frame type");
    if (type === "control_request") {
      requireId(envelope.request_id);
      if (!plain(envelope.request) || !methodOk(envelope.request.subtype)) throw new Error("invalid Claude control request");
      return { id: envelope.request_id, method: envelope.request.subtype, params: envelope.request };
    }
    if (type === "control_response") {
      const response = envelope.response;
      if (!plain(response)) throw new Error("invalid Claude control response");
      requireId(response.request_id);
      if (response.subtype === "success") {
        if (response.response != null && !plain(response.response)) throw new Error("invalid Claude control response result");
        return { id: response.request_id, result: response.response ?? {} };
      }
      if (response.subtype === "error" && typeof response.error === "string") {
        return { id: response.request_id, error: { code: "CLAUDE_CONTROL_ERROR", message: response.error } };
      }
      throw new Error("invalid Claude control response subtype or error");
    }
    if (type === "control_cancel_request") {
      requireId(envelope.request_id);
      return { method: "claude/control_cancel_request", params: { requestId: envelope.request_id } };
    }
    if (type.startsWith("control_")) throw new Error("unknown Claude control frame type");
    return { method: "claude/event", params: envelope };
  },
});
