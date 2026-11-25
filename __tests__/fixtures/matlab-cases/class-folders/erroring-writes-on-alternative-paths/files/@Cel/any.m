function b = any(x)
x = x ~= 0;
x = x == 0;
b = sum(x);
end
