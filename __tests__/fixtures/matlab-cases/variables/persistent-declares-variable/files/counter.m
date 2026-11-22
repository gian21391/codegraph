function y = counter()
persistent count
if isempty(count)
    count = 0;
end
persistent cache
y = count(1) + cache(2);
end
