const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

export function jsonResponse(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: JSON_HEADERS });
}

export function errorResponse(status: number, code: string): Response {
	return jsonResponse({ error: code }, status);
}

export function methodNotAllowed(allowed: string[]): Response {
	const response = errorResponse(405, "method_not_allowed");
	response.headers.set("allow", allowed.join(", "));
	return response;
}
