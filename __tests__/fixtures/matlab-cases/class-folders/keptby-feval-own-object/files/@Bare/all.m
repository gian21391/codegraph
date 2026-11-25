function b = all(x)
x = numel(x);
b = feval('sum', x);
end
