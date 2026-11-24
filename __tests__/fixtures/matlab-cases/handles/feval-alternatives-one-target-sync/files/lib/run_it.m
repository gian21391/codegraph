function run_it(c)
import pkg.*
if c, fn = 'pkg.f'; else, fn = 'f'; end
feval(fn, 1);
end
