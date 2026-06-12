local M = {}

function M.clamp(v, lo, hi)
	return math.max(lo, math.min(hi, v))
end

M.round = function(v)
	return math.floor(v + 0.5)
end

return M
