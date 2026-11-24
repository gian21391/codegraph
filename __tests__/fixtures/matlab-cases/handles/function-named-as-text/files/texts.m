function texts(c, x0)
h = str2func('myfun');
cellfun('myfun2', c);
cellfun('isempty', c);
cellfun('size', c);
fzero('fbase', x0);
end
