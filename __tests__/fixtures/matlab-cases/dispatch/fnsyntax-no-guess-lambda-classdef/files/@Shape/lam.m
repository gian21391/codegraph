function f = lam(obj, parts)
f = arrayfun(@(L) render(L), parts);
end
