classdef Pod
methods
function obj = subs(obj)
end
function tidy(obj)
end
function go(obj)
obj = subs(obj);
tidy(obj);
end
function stop(obj)
obj = numel(obj);
tidy(obj);
end
end
end
