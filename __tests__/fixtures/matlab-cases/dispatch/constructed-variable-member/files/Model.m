classdef Model < handle
    methods
        function reset(obj)
        end
        function v = compute(obj)
            v = 1;
        end
    end
    methods (Static)
        function s = make()
            s = Model();
        end
    end
end
