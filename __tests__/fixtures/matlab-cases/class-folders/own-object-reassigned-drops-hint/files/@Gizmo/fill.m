function obj = fill(obj, v)
if isempty(v)
  obj = v;
  return;
end
tidy(obj);
end
